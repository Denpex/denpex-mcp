import {afterEach,describe,expect,it} from 'vitest';
import {registerFollowup} from './tools/followup';
import {rememberDiagnosis,followupEvidenceKey,clearRememberedDiagnoses} from './followup-state';
afterEach(()=>clearRememberedDiagnoses());
describe('MCP follow-up report parity',()=>{
  it('preserves evidence, verification, applicability and conversation identity',async()=>{
    const logs='RuntimeError: actual incident evidence';rememberDiagnosis(followupEvidenceKey(logs),'report_123');
    let callback:any;const server={registerTool:(_name:any,_schema:any,handler:any)=>{callback=handler}};
    const reply={summary:'Supported follow-up',action:'Manual candidate',evidence:[logs],verificationCommand:'Check intended gradients',confidenceDisplay:null,resumeSafetyNote:'Do not resume before checkpoint integrity is checked',forensicReport:{remedyApplicability:{scope:'Exact workload',prerequisites:['Verify the versions'],verification:'Compare the outputs',repairVerified:false}}};
    registerFollowup(server as any,{config:{apiKey:'test',local:false,privacy:'off',apiUrl:'https://api.denpex.com'},client:{request:async()=>({reply,conversationId:'conversation_123'})} as any});
    const result=await callback({logs,question:'Did this apply?',history:[]});
    const text=result.content[0].text;
    for(const phrase of [logs,'Check intended gradients','Exact workload','Verify the versions','Compare the outputs','does not authorize remote execution or certify workload recovery'])expect(text).toContain(phrase);
    expect(result.structuredContent.conversationId).toBe('conversation_123');expect(result.structuredContent.diagnosisId).toBe('report_123');
    expect(result.structuredContent.forensicReport.remedyApplicability.repairVerified).toBe(false);
    expect(text).toContain(reply.resumeSafetyNote);expect(result.structuredContent.resumeSafetyNote).toBe(reply.resumeSafetyNote);
  });
});
