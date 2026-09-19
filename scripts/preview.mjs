import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
// Local visual review only; production bundle is never modified.
createServer(async (_req,res) => {
  const html=await readFile('e2e/jira.html','utf8')
  const fixture=await readFile('e2e/fixture.js','utf8')
  const code=(await readFile('dist/tempo.user.js','utf8')).replaceAll('location.hostname','"demo.atlassian.net"')
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'})
  res.end(html.replace('</body>',`<script>${fixture}</script><script>${code}</script></body>`))
}).listen(4177,'127.0.0.1',()=>console.log('Local demo: http://127.0.0.1:4177/browse/NOVA-318'))
