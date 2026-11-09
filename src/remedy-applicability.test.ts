import {describe,expect,it} from 'vitest';
import {renderDiagnosis,viewFromCloud} from './format';
describe('remedy handoff matches the web report',()=>{
  it('presents scope, prerequisites and recovery limits rather than dropping them',()=>{
    const view=viewFromCloud({fix:{summary:'Supported cause',action:'Manual candidate',confidenceDisplay:null},meta:{failureType:'TEST'},forensicReport:{remedyApplicability:{scope:'Exact mask and dtype',prerequisites:['Confirm the installed stack'],verification:'Compare intended gradients',repairVerified:false,automaticExecution:false}}});
    const text=renderDiagnosis(view);
    for(const phrase of ['Exact mask and dtype','Confirm the installed stack','Compare intended gradients','does not authorize remote execution or certify workload recovery'])expect(text).toContain(phrase);
    expect(text).not.toContain('Repair verified');
  });
});
