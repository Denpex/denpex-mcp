import {afterEach,describe,expect,it,vi} from 'vitest';
import {DenpexClient} from './client';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('complete MCP response deadline',()=>{
  it('times out a stalled response body after successful headers',async()=>{
    vi.useFakeTimers();
    vi.stubGlobal('fetch',vi.fn(async(_url,options)=>({ok:true,text:()=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true}))})));
    const client=new DenpexClient({apiUrl:'https://api.denpex.com',local:false,privacy:'off'});
    const result=client.request('/api/diagnose',{timeoutMs:100});
    const rejection=expect(result).rejects.toMatchObject({status:504,message:'Request timed out'});
    await vi.advanceTimersByTimeAsync(101);await rejection;
  });
  it('preserves API error status and body after reading it',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:429,text:async()=>'{"error":"Quota reached"}'})));
    const client=new DenpexClient({apiUrl:'https://api.denpex.com',local:false,privacy:'off'});
    await expect(client.request('/api/diagnose')).rejects.toMatchObject({status:429,body:{error:'Quota reached'}});
  });
});
