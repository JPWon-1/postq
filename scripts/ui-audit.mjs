// Headless visual audit, using screenshots.mjs's isolated demo database and local servers.
import { chromium } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function audit({ base, ports, demo, out, setSpecVersion }) {
 const browser = await chromium.launch({ headless: true })
 const context = await browser.newContext({ viewport: { width:1440,height:900 }, locale:'ko-KR' })
 await context.addInitScript(() => {localStorage.clear();localStorage.setItem('ah:workspace','default');localStorage.setItem('theme','dark')})
 const page = await context.newPage(); page.setDefaultTimeout(6000)
 const previous = process.env.AUDIT_ONLY ? JSON.parse(await readFile(join(out,'manifest.json'),'utf8')) : {records:[],failures:[]}
 const records=previous.records, failures=previous.failures
 const only=process.env.AUDIT_ONLY?.split(',')
 const api=async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(`${path}: ${r.status} ${await r.text()}`);return r.json()}
 const button=(name)=>page.getByRole('button',{name,exact:true})
 const shot=async(name)=>{
  await page.waitForTimeout(150)
  for(const theme of ['dark','light'])for(const [width,height] of [[1280,800],[1440,900],[1920,1080]]){
   await page.setViewportSize({width,height}); await page.emulateMedia({colorScheme:theme})
   await page.evaluate(t=>{localStorage.setItem('theme',t);document.documentElement.dataset.theme=t;window.dispatchEvent(new CustomEvent('ah:themepref',{detail:t}))},theme)
   await page.waitForTimeout(250)
   const file=`${name}--${theme}--${width}x${height}.png`
   const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,iconOnly:[...document.querySelectorAll('button')].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width&&e.getBoundingClientRect().height&&!/[\p{L}\p{N}]/u.test(e.innerText)).map(e=>({label:e.getAttribute('aria-label')||e.title||'',text:e.innerText})).slice(0,70)}))
   await page.screenshot({path:join(out,file)});records.splice(0,records.length,...records.filter(r=>r.file!==file),{state:name,file,...metrics})
  }
  await writeFile(join(out,'manifest.json'),JSON.stringify({records,failures},null,2));console.log('[audit]',name)
 }
 const task=async(name,fn)=>{if(only&&!only.includes(name))return;try{await fn();for(let i=failures.length-1;i>=0;i--)if(failures[i].state===name)failures.splice(i,1)}catch(e){failures.push({state:name,error:e.message});console.error('[audit FAIL]',name,e.message);await writeFile(join(out,'manifest.json'),JSON.stringify({records,failures},null,2))}}
 const home=async(id)=>{await page.goto(base+(id?`/?req=${id}`:'/'));await page.getByTestId('rail-settings').waitFor();await page.getByLabel('실행 환경',{exact:true}).selectOption(demo.local.id);await page.waitForTimeout(150)}
 const settings=async(tab)=>{await home();await page.getByTestId('rail-settings').click();await page.getByTestId(`settings-${tab}`).click();await page.waitForTimeout(200)}
 try{
 await mkdir(out,{recursive:true})
 await task('collection',async()=>{await home();await shot('collection-expanded');await page.getByText('사용자',{exact:true}).first().click();await shot('folder-overview');await button('Authorization').click();await shot('folder-auth');await button('Headers').click();await shot('folder-headers')})
 await task('tree-states',async()=>{await home(demo.getUser.id);await shot('tree-selected');const folder=page.getByText('사용자',{exact:true}).first();await folder.hover();await shot('tree-hover');await button("'사용자' 폴더 작업").click();await shot('tree-menu');await page.keyboard.press('Escape');await folder.click({button:'right'});await shot('tree-right-click');const row=page.locator('[draggable=true]').filter({hasText:'사용자 목록'}).first();const box=await row.boundingBox();await page.mouse.move(box.x+30,box.y+12);await page.mouse.down();await page.mouse.move(box.x+45,box.y+65,{steps:8});await shot('tree-drag');await page.mouse.up()})
 await task('request-row-menu',async()=>{await home(demo.getUser.id);const menu=page.getByRole('button',{name:'사용자 조회 요청 작업',exact:true});await menu.focus();await menu.click();await shot('request-row-menu');await page.keyboard.press('Escape')})
 await task('variable-editor',async()=>{await home(demo.getUser.id);await page.getByRole('button',{name:'baseUrl 변수 값',exact:true}).first().click();await shot('variable-editor')})
 for(const tab of ['Docs','Params','Authorization','Headers','Body','Scripts','Tests','Settings'])await task(`request-${tab}`,async()=>{await home(demo.getUser.id);await page.getByTestId('request-area').getByRole('button',{name:new RegExp('^'+tab+'(?:\\s|$)')}).click();await shot(`request-${tab.toLowerCase()}`)})
 for(const auth of ['none','inherit','bearer','basic','apikey','oauth2cc'])await task(`auth-${auth}`,async()=>{await home(demo.getUser.id);await page.getByTestId('request-area').getByRole('button',{name:/^Authorization/}).click();await page.getByLabel('인증 방식',{exact:true}).selectOption(auth);await shot(`auth-${auth}`)})
 for(const kind of ['none','json','form','raw','graphql','multipart','binary'])await task(`body-${kind}`,async()=>{await home(demo.createUser.id);await button('Body').click();await page.getByLabel('바디 타입',{exact:true}).selectOption(kind);await shot(`body-${kind}`)})
 for(const panel of ['코드 스니펫','변수'])await task(panel,async()=>{await home(demo.getUser.id);await button(panel).click();await shot(panel==='변수'?'panel-variables':'panel-code')})
 await task('success',async()=>{await home(demo.getUser.id);await page.getByTestId('run-request').click();await page.getByTitle('OK — 성공').waitFor();await shot('response-success');await button('콘솔').click();await shot('console');await button('링크 복사').click();await shot('toast-success')})
 // Response payloads use the real execution API with a loopback-only fixture server.
 const {createServer}=await import('node:http')
 const fixture=createServer((req,res)=>{let status=200,type='application/json',body='{}';const k=req.url;
 if(k==='/4xx'){status=404;body=JSON.stringify({error:'찾을 수 없는 사용자',requestId:'demo-404'})}
 if(k==='/5xx'){status=503;body=JSON.stringify({error:'잠시 후 다시 시도하세요',retryAfter:30})}
 if(k==='/large')body=JSON.stringify({items:Array.from({length:600},(_,i)=>({id:i+1,name:`Sample item ${i+1}`,active:true,details:{description:'여러 줄의 JSON 응답을 확인합니다',price:12000}}))})
 if(k==='/html'){type='text/html';body='<html><body><h1>Sample response</h1><p>HTML 응답 미리보기</p></body></html>'}
 if(k==='/image'){type='image/png';body=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')}
 if(k==='/binary'){type='application/octet-stream';body=Buffer.from([0,1,2,3,4,5,254,255])}
 res.writeHead(status,{'content-type':type});res.end(body)})
 let fixturePort=39690; for(;;){try{await new Promise((r,j)=>{fixture.once('error',j);fixture.listen(fixturePort,'127.0.0.1',r)});break}catch(e){if(e.code!=='EADDRINUSE')throw e;fixturePort++}}
 try{for(const kind of ['4xx','5xx','error','large','html','image','binary','test-failure'])await task(`response-${kind}`,async()=>{
  const r=await api('POST','/api/requests',{folderId:demo.users.id,name:`응답 ${kind}`,method:'GET',url:kind==='error'?'http://127.0.0.1:9':`http://127.0.0.1:${fixturePort}/${kind}`,assertions:kind==='test-failure'?[{target:'status',op:'eq',expected:'201'}]:[]})
  await home(r.id);await Promise.all([page.waitForResponse(r=>r.url().includes('/execute')&&r.request().method()==='POST'),page.getByTestId('run-request').click()]);await page.waitForTimeout(200)
  if(kind==='html' && await button('Preview').count())await button('Preview').click()
  await shot(`response-${kind}`)
 })}finally{await new Promise(r=>fixture.close(r))}
 await task('history',async()=>{await home();await page.getByTestId('rail-history').click();await page.getByTestId('global-history').waitFor();await shot('history-list');await page.getByLabel('이력 검색').fill('사용자');await shot('history-filter');await page.getByLabel('이력 검색').fill('');await page.getByTestId('global-history').getByRole('button').filter({hasText:'GET'}).first().click();await shot('history-detail')})
 await task('scenario',async()=>{await home();await page.getByTestId('rail-scenario').click();await shot('scenario-list');await button('주문 생성 후 조회 열기').click();await shot('scenario-edit');await page.getByRole('button',{name:'▶ 시나리오 실행',exact:true}).click();await page.getByText(/시나리오 완료/).first().waitFor();await shot('scenario-result');await page.getByRole('button',{name:/스텝 1 설정/}).click();await shot('scenario-step');await page.keyboard.press('Escape');await button('주문 생성 후 조회 삭제').click();await shot('confirmation');await page.keyboard.press('Escape')})
 await task('scenario-failure',async()=>{const r=await api('POST','/api/requests',{folderId:demo.users.id,name:'연결 실패 예시',method:'GET',url:'http://127.0.0.1:9'});const f=await api('POST','/api/flows',{name:'실패 예시',steps:[{requestId:r.id,extracts:[]}]});await home();await page.getByTestId('rail-scenario').click();await button('실패 예시 열기').click();await page.getByRole('button',{name:'▶ 시나리오 실행',exact:true}).click();await page.waitForTimeout(700);await shot('scenario-failure')})
 await task('schedule',async()=>{await home();await page.getByTestId('rail-schedule').click();await shot('schedule-list');await page.getByRole('button',{name:'+ 스케줄 추가',exact:true}).click();await shot('schedule-create')})
 await task('realtime',async()=>{await home();await page.getByTestId('rail-ws').click();await shot('ws-empty');await page.getByLabel('WebSocket 주소').fill(`ws://127.0.0.1:${ports.ws}`);await button('연결').click();await page.getByLabel('보낼 메시지').fill('Hello, postq');await button('전송').click();await page.waitForTimeout(250);await shot('ws-connected');await button('연결 끊기').click();await button('SSE / 스트리밍').click();await shot('sse-empty');await page.getByLabel('스트림 URL').fill(`http://127.0.0.1:${ports.echo}/sse`);await button('연결').last().click();await page.waitForTimeout(1100);await shot('sse-events')})
 for(const tab of ['env','display','shortcuts','cookies','data','ai','diagnostics','about'])await task(`settings-${tab}`,async()=>{await settings(tab);await shot(`settings-${tab}`)})
 await task('environment',async()=>{await settings('env');await page.getByLabel('환경 선택').selectOption(demo.local.id);await shot('environment-edit');await button('apiToken 비밀값 변경').click();await shot('environment-secret')})
 await task('palette',async()=>{await home();await page.keyboard.press('ControlOrMeta+k');await shot('palette');await page.getByRole('textbox',{name:'명령·요청 검색'}).fill('환경');await shot('palette-search')})
 await task('import-export',async()=>{await home();await page.getByTestId('list-overflow').click();await shot('import-export-menu');await page.locator('input[type=file][accept*="json"]').first().setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{broken')});await shot('toast-error')})
 await task('openapi',async()=>{await home();await button('폴더').click();await page.getByLabel('OpenAPI 주소에서 요청 가져오기').check();await shot('openapi-add');await home();setSpecVersion(2);await page.getByText('Petstore',{exact:true}).first().hover();await button("'Petstore' 스펙 동기화").click();await page.waitForTimeout(400);await shot('openapi-sync')})
 await task('focus',async()=>{await home(demo.getUser.id);await button('집중 모드').click();await shot('focus-mode');await button('집중 모드 해제').click();await page.getByTestId('toggle-rail').click();await shot('sidebar-collapsed')})
 await task('details',async()=>{
  for(const tab of ['Docs','Scripts','Tests','Settings']){await home(demo.getUser.id);await page.getByTestId('request-area').getByRole('button',{name:new RegExp('^'+tab+'(?:\\s|$)')}).click();await page.getByTestId('request-tab-content').evaluate(el=>el.scrollTop=el.scrollHeight);await shot(`request-${tab.toLowerCase()}-bottom`)}
  await home(demo.getUser.id);await button('Cookies').click();await shot('request-cookies')
  await home();await page.getByTestId('rail-settings').focus();await shot('keyboard-focus')
  await settings('cookies');await page.getByLabel('쿠키 도메인 필터').fill('not-found.example');await shot('empty-cookies')
  await settings('env');await shot('environment-list')
 })
 await task('empty',async()=>{const ws=await api('POST','/api/workspaces',{name:'빈 프로젝트'});await page.addInitScript(id=>localStorage.setItem('ah:workspace',id),ws.id);await page.goto(base+'/');await page.getByTestId('start-guide').waitFor();await shot('empty-collection');await page.getByTestId('rail-history').click();await shot('empty-history');await page.getByTestId('rail-scenario').click();await shot('empty-scenario');await page.getByTestId('rail-schedule').click();await shot('empty-schedule')})
 }finally{await writeFile(join(out,'manifest.json'),JSON.stringify({records,failures},null,2));await browser.close()}
 if(failures.length)throw Error(`${failures.length} audit states failed; see manifest.json`)
}
