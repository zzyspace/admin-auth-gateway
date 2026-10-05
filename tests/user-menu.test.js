import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../server/account-store.js';
import { createSessionDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

test('shared user menu assets are public but identity stays session-protected', async t => {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'user-menu-test-'));
  const accounts=createAccountStore({stateDir}),database=createSessionDatabase({stateDir});
  accounts.createAccount({accountId:'owner',username:'owner-login',displayName:'林小雨 <测试>',password:'fixture-password'},{actor:'fixture'});
  accounts.createAccount({accountId:'worker',username:'worker-login',displayName:'陈晓明',password:'fixture-password'},{actor:'fixture'});
  accounts.putAccess({accountId:'worker',app:'invoice',role:'admin',permissions:['submission:view'],config:{viewScope:{ownership:'any',stores:'all'}}},{actor:'fixture',expectedVersion:0});
  const config=loadConfig({ADMIN_AUTH_MODE:'unified',ADMIN_AUTH_INTERNAL_TOKEN:'fixture-secret-000000000000000000000',ADMIN_AUTH_MANAGEMENT_ACCOUNT_IDS:'owner',ADMIN_AUTH_COOKIE_SECURE:'false',ADMIN_AUTH_COOKIE_NAME:'admin_session'});
  const {app,sessions}=createApp({config,accounts,database});
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();accounts.close();fs.rmSync(stateDir,{recursive:true,force:true});});
  for(const filename of ['user-menu.js','user-menu.css']){
    const response=await fetch(base+'/auth/accounts/'+filename);
    assert.equal(response.status,200);
    assert.equal(await response.text(),fs.readFileSync(new URL('../public/'+filename,import.meta.url),'utf8'));
  }
  assert.equal((await fetch(base+'/auth/api/session')).status,401);
  assert.equal((await fetch(base+'/auth/accounts',{redirect:'manual'})).status,303);
  const token=sessions.login('owner-login','fixture-password').token;
  const headers={Cookie:`admin_session=${token}`};
  const ownerSession=await (await fetch(base+'/auth/api/session',{headers})).json();
  assert.deepEqual(ownerSession.account,{displayName:'林小雨 <测试>'});
  assert.deepEqual(ownerSession.scopes,{}); // A management-only account still has its own real name.
  const page=await fetch(base+'/auth/accounts?account=worker',{headers});
  const html=await page.text();
  assert.match(html,/data-account-name="林小雨 &lt;测试&gt;"/); // Current actor, not selected account.
  assert.match(html,/action="\/logout" method="post"/);
  assert.match(html,/name="returnTo" value="\/auth\/accounts"/);
  assert.match(page.headers.get('content-security-policy'),/style-src 'self' 'unsafe-inline'/);
  const workerToken=sessions.login('worker-login','fixture-password').token;
  assert.deepEqual((await (await fetch(base+'/auth/api/session',{headers:{Cookie:`admin_session=${workerToken}`}})).json()).account,{displayName:'陈晓明'});
  assert.equal((await fetch(base+'/auth/accounts',{headers:{Cookie:`admin_session=${workerToken}`}})).status,403);
  const logout=await fetch(base+'/logout',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({returnTo:'/auth/accounts'}),redirect:'manual'});
  assert.equal(logout.status,303);
  assert.equal((await fetch(base+'/auth/api/session',{headers})).status,401);
});
