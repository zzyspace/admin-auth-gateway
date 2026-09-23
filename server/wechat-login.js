import express from 'express';
import { randomToken, parseCookies } from './security.js';
import { createLoginRateLimiter } from './rate-limit.js';
import { renderLoginPage, LOGIN_THEME_SCRIPT_HASH } from './login-page.js';
import { WechatFlowError } from './wechat-store.js';
export async function exchangeWechatCode({ appId, secret }, code) {
  if(typeof code!=='string'||!code||code.length>512) throw new Error('invalid-code');
  const url=new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search=new URLSearchParams({appid:appId,secret,js_code:code,grant_type:'authorization_code'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!response.ok) throw new Error('wechat-unavailable');
  const data=await response.json();
  if(data.errcode || typeof data.openid!=='string'||!data.openid) throw new Error('wechat-rejected');
  // session_key is intentionally neither persisted nor returned.
  return data.openid;
}
export function installWechatLogin({app,config,accounts,sessions,issueSession,exchangeCode=exchangeWechatCode,now=Date.now}) {
  const enabled=()=>config.authMode==='unified'&&config.wechat?.enabled===true;
  const name=config.cookie.secure?'__Host-wechat_flow':'wechat_flow';
  const cookie={httpOnly:true,secure:config.cookie.secure,sameSite:'lax',path:'/'};
  const browser=request=>parseCookies(request.headers.cookie).get(name);
  const limiter=createLoginRateLimiter({windowSeconds:60,maxAttempts:30,now});
  const limited=(request,response)=>{
    const key=request.ip||'unknown'; if(limiter.isLimited(key)){response.status(429).json({error:'请求过于频繁，请稍后再试。'});return true;} limiter.recordFailure(key);return false;
  };
  const fail=(response,error)=>response.status(400).type('text/plain').send(error instanceof WechatFlowError?error.message:'微信登录失败，请返回工作台重试或使用账号密码登录。');
  app.get('/auth/wechat/config',(_request,response)=>response.json({enabled:enabled()}));
  app.use('/auth/wechat',(_request,response,next)=>{
    response.set('Referrer-Policy','origin'); if(!enabled()) return response.sendStatus(404); next();
  });
  app.post('/auth/wechat/flows',express.json({limit:'2kb'}),(request,response)=>{
    if(request.get('Origin')!==config.wechat.origin) return response.sendStatus(403);
    if(limited(request,response)) return;
    try { const token=randomToken(), flowId=accounts.startWechatFlow(config.wechat.appId,token);
      response.cookie(name,token,{...cookie,maxAge:300000}); response.json({flowId});
    } catch(error){fail(response,error);}
  });
  app.post('/auth/wechat/exchange',express.json({limit:'4kb'}),async(request,response)=>{
    if(limited(request,response)) return;
    const {flowId,code}=request.body??{};
    if (typeof code !== 'string' || !code || code.length > 512) return fail(response,new Error('invalid-code'));
    try {
      accounts.claimWechatFlow(flowId,config.wechat.appId);
      try { const openId=await exchangeCode(config.wechat,code); accounts.finishWechatExchange(flowId,openId); }
      catch(error){accounts.failWechatFlow(flowId);throw error;}
      response.json({success:true});
    } catch(error){fail(response,error);}
  });
  app.get('/auth/wechat/complete',(request,response)=>{
    const flowId=request.query.flowId;
    try {
      const state=accounts.inspectWechatFlow(flowId,browser(request));
      if(state.needsBinding){
        const csrfToken=randomToken();
        response.cookie('admin_login_csrf',csrfToken,{httpOnly:true,secure:config.cookie.secure,sameSite:'strict',path:'/login',maxAge:300000});
        response.set('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${LOGIN_THEME_SCRIPT_HASH}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
        return response.type('html').send(renderLoginPage({csrfToken,returnTo:'/mini.html',sessionDays:Math.ceil(config.cookie.maxAgeSeconds/86400),bindingFlowId:flowId}));
      }
      const matches=sessions.authorizeAccount(state.account.accountId);
      if(!matches.length) throw new WechatFlowError('账号暂无可用权限，请联系管理员。');
      accounts.consumeWechatFlow(flowId,browser(request));
      response.clearCookie(name,cookie); issueSession(request,response,matches); response.redirect(303,'/mini.html?wechatLogin=1');
    } catch(error){fail(response,error);}
  });
  app.use('/auth/wechat', (error,_request,response,_next) => response.status(error.status === 413 ? 413 : 400).json({error:'微信登录请求无效，请重新发起。'}));
  return {
    validateBinding(request) {
      const id=request.body?.bindingFlowId; if(!id) return '';
      if(!enabled()||request.get('Origin')!==config.wechat.origin) throw new WechatFlowError('微信绑定请求无效，请重新发起。');
      if(!accounts.inspectWechatFlow(id,browser(request)).needsBinding) throw new WechatFlowError('请重新发起微信绑定。'); return id;
    },
    bind(request,response,id,account) { accounts.bindWechatFlow(id,browser(request),account.accountId,account.version);response.clearCookie(name,cookie); },
  };
}
