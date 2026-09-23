import { hashToken, randomToken, secureEqual } from './security.js';
export class WechatFlowError extends Error {}
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const fail = () => { throw new WechatFlowError('微信登录流程已失效，请重新发起。'); };
export function installWechatStore({ db, now, getAccount, audit }) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_wechat_bindings (
    app_id TEXT NOT NULL, open_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(account_id),
    created_at INTEGER NOT NULL, PRIMARY KEY(app_id,open_id), UNIQUE(app_id,account_id));
    CREATE TABLE IF NOT EXISTS wechat_login_flows (
    flow_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, app_id TEXT NOT NULL,
    state TEXT NOT NULL, open_id TEXT, account_id TEXT, account_version INTEGER, binding_created_at INTEGER,
    expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wechat_flow_expiry ON wechat_login_flows(expires_at);`);
  function flow(id, browser, states) {
    if (states.some(state => state === 'ready' || state === 'binding') && !valid(browser)) fail();
    if (!valid(id)) fail();
    const row = db.prepare('SELECT * FROM wechat_login_flows WHERE flow_hash=?').get(hashToken(id));
    if (!row || row.expires_at <= now() || !states.includes(row.state)) fail();
    if (browser !== undefined && (!valid(browser) || !secureEqual(row.browser_hash, hashToken(browser)))) fail();
    return row;
  }
  function binding(appId, openId) { return db.prepare('SELECT * FROM account_wechat_bindings WHERE app_id=? AND open_id=?').get(appId,openId); }
  function usable(row) {
    const account = getAccount(row.account_id), link = binding(row.app_id,row.open_id);
    if (!account?.enabled || account.version !== row.account_version || !link || link.account_id !== account.accountId || link.created_at !== row.binding_created_at) fail();
    return account;
  }
  return {
    cleanupWechatFlows() { return db.prepare('DELETE FROM wechat_login_flows WHERE expires_at<=?').run(now()).changes; },
    startWechatFlow(appId, browser) {
      if (!valid(browser)) fail();
      db.prepare('DELETE FROM wechat_login_flows WHERE expires_at<=?').run(now());
      if (db.prepare('SELECT count(*) AS count FROM wechat_login_flows').get().count >= 1000) fail();
      const id = randomToken();
      db.prepare('INSERT INTO wechat_login_flows (flow_hash,browser_hash,app_id,state,expires_at) VALUES (?,?,?,\'created\',?)').run(hashToken(id),hashToken(browser),appId,now()+300000);
      return id;
    },
    claimWechatFlow: db.transaction((id, appId) => {
      const row=flow(id,undefined,['created']); if(row.app_id!==appId) fail();
      db.prepare("UPDATE wechat_login_flows SET state='exchanging' WHERE flow_hash=?").run(row.flow_hash);
    }).immediate,
    failWechatFlow(id) { if(valid(id)) db.prepare('DELETE FROM wechat_login_flows WHERE flow_hash=?').run(hashToken(id)); },
    finishWechatExchange: db.transaction((id, openId) => {
      const row=flow(id,undefined,['exchanging']);
      if(typeof openId!=='string'||!openId||openId.length>128) fail();
      const link=binding(row.app_id,openId), account=link&&getAccount(link.account_id);
      if(link&&!account?.enabled) fail();
      db.prepare('UPDATE wechat_login_flows SET state=?,open_id=?,account_id=?,account_version=?,binding_created_at=? WHERE flow_hash=?').run(link?'ready':'binding',openId,account?.accountId??null,account?.version??null,link?.created_at??null,row.flow_hash);
    }).immediate,
    inspectWechatFlow(id,browser) { const row=flow(id,browser,['ready','binding']); return { needsBinding:row.state==='binding', account:row.state==='ready'?usable(row):null }; },
    consumeWechatFlow: db.transaction((id,browser) => {
      const row=flow(id,browser,['ready']); const account=usable(row);
      db.prepare('DELETE FROM wechat_login_flows WHERE flow_hash=?').run(row.flow_hash); return account;
    }).immediate,
    bindWechatFlow: db.transaction((id,browser,accountId,expectedVersion) => {
      const row=flow(id,browser,['binding']), account=getAccount(accountId);
      if(!account?.enabled||account.version!==expectedVersion) fail();
      if(binding(row.app_id,row.open_id)||db.prepare('SELECT 1 FROM account_wechat_bindings WHERE app_id=? AND account_id=?').get(row.app_id,accountId)) throw new WechatFlowError('微信或账号已绑定，请联系管理员解绑后重试。');
      db.prepare('INSERT INTO account_wechat_bindings VALUES (?,?,?,?)').run(row.app_id,row.open_id,accountId,now());
      db.prepare('DELETE FROM wechat_login_flows WHERE flow_hash=?').run(row.flow_hash);
      audit(accountId,'wechat:bind',accountId,null,account.version,{appId:row.app_id}); return account;
    }).immediate,
    wechatBindingStatus(accountId) { return db.prepare('SELECT app_id AS appId,created_at AS createdAt FROM account_wechat_bindings WHERE account_id=?').all(accountId); },
    unlinkWechat: db.transaction((accountId,appId,{actor,expectedVersion}) => {
      const account=getAccount(accountId); if(!account||account.version!==expectedVersion) fail();
      const result=db.prepare('DELETE FROM account_wechat_bindings WHERE account_id=? AND app_id=?').run(accountId,appId);
      if(!result.changes) fail();
      db.prepare('UPDATE accounts SET version=version+1 WHERE account_id=?').run(accountId);
      db.prepare('DELETE FROM wechat_login_flows WHERE account_id=?').run(accountId);
      audit(actor,'wechat:unlink',accountId,null,account.version+1,{appId});
    }).immediate,
  };
}
