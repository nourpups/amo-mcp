// Actual application and OAuth handlers; only external amoCRM is stubbed.
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {createHttpApp} from '../dist/http-server.js';
import {buildServer} from '../dist/server.js';
import {createAuth,hashPassword} from '../dist/auth.js';
const require=createRequire(join(homedir(),'.local/share/dev-verification/browser/package.json'));
const {chromium}=require('@playwright/test');
const pem=execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','/dev/stdout','-out','/dev/stdout','-subj','/CN=localhost','-days','1'],{stdio:['ignore','pipe','ignore']}).toString();
const server=createServer({key:pem,cert:pem});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`https://127.0.0.1:${server.address().port}`;
const login='browser-test',password=randomBytes(24).toString('base64url');
const service=createHttpApp(buildServer,{port:0,publicUrl:`${base}/amo/mcp`,dbPath:':memory:',encryptionKey:randomBytes(32).toString('base64'),login,passwordHash:hashPassword(password),authFactory:options=>createAuth({...options,validateAmo:async(domain,token)=>{if(!['first','second'].includes(domain)||token!=='test-integration-token')throw Error('Rejected test upstream');}})});
server.on('request',service.app);
const callbackServer=createServer({key:pem,cert:pem},(_req,res)=>{res.end('Connected');});
await new Promise(r=>callbackServer.listen(0,'127.0.0.1',r));
const callback=`https://127.0.0.1:${callbackServer.address().port}/callback`;
const browser=await chromium.launch();
const dir=join(homedir(),'.local/state/dev-verification/amo-browser-'+Date.now());
await mkdir(dir,{recursive:true,mode:0o700});
const checks=[];
try {
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:900}});
 const request=context.request;
 const resource=`${base}/amo/mcp`;
 const unauth=await request.post(resource,{data:{}});assert.equal(unauth.status(),401);
 const metadata=await (await request.get(`${base}/.well-known/oauth-protected-resource/amo/mcp`)).json();assert.equal(metadata.resource,resource);
 const as=await(await request.get(`${base}/.well-known/oauth-authorization-server/amo`)).json();assert.equal(as.issuer,`${base}/amo`);
 const registration=await request.post(as.registration_endpoint,{data:{client_name:'Browser acceptance',redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'}});
 assert.equal(registration.status(),201);const client=await registration.json();
 const flows=[];
 for(const domain of ['first','second']) {
  const page=await context.newPage();
  page.on('response',r=>{if(r.request().isNavigationRequest())console.log('browser-navigation',r.status(),new URL(r.url()).pathname)});
  page.on('console',m=>{if(m.type()==='error')console.log('browser-console-error')});
  const verifier=randomBytes(32).toString('base64url');const state=randomBytes(16).toString('hex');
  const params=new URLSearchParams({client_id:client.client_id,redirect_uri:callback,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state,resource,scope:'amo:read offline_access'});
  await page.goto(as.authorization_endpoint+'?'+params);
  await page.getByLabel('Логин',{exact:true}).fill(login);
  await page.getByLabel('Пароль',{exact:true}).fill('wrong');
  await page.getByRole('button').click();
  try { await page.getByRole('alert').waitFor({timeout:5000}); } catch(e) { console.log('visible-page',await page.locator('body').innerText()); throw e; }
  await page.getByLabel('Логин',{exact:true}).fill(login);
  await page.getByLabel('Пароль',{exact:true}).fill(password);
  await page.getByRole('button').click();
  await page.getByRole('heading',{name:'Подключение amoCRM'}).waitFor();
  await page.getByLabel('Домен amoCRM',{exact:true}).fill(domain);
  await page.getByLabel('Долгосрочный токен интеграции',{exact:true}).fill('rejected');
  await page.getByRole('button').click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('Домен amoCRM',{exact:true}).fill(domain);
  await page.getByLabel('Долгосрочный токен интеграции',{exact:true}).fill('test-integration-token');
  await page.screenshot({path:join(dir,domain+'-connect.png'),mask:[page.getByLabel('Долгосрочный токен интеграции',{exact:true})]});
  flows.push({page,verifier,state});
 }
 const tokens=[];
 for(const flow of flows){
  await flow.page.getByRole('button').click();
  await flow.page.waitForURL(callback+'?**');
  const redirect=new URL(flow.page.url());assert.equal(redirect.searchParams.get('state'),flow.state);
  const response=await request.post(as.token_endpoint,{form:{grant_type:'authorization_code',client_id:client.client_id,redirect_uri:callback,code:redirect.searchParams.get('code'),code_verifier:flow.verifier,resource}});
  assert.equal(response.status(),200);tokens.push(await response.json());
 }
 assert.notEqual(tokens[0].access_token,tokens[1].access_token);
 for(const token of tokens){
  const init=await request.post(resource,{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'browser',version:'1'}}}});assert.equal(init.status(),200);
 }
 checks.push('discovery and unauthorized challenge','wrong login rejected','invalid external token rejected','two browser flows isolated','OAuth callbacks and PKCE exchange','authenticated MCP initialize');
 await context.close();
 console.log(JSON.stringify({status:'passed',backend:'mixed (real application, stub external amoCRM)',checks,screenshots:dir}));
} finally {await browser.close();await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));callbackServer.closeAllConnections();await new Promise(r=>callbackServer.close(r));}
