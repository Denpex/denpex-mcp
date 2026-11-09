/** Shared wire/presentation contract. Generated client copies must stay byte-identical. */
export interface ClarificationChoice {
  id: string; kind: 'fact' | 'action'; question: string; allowOther: boolean;
  options: Array<{id: string; label: string; detail?: string; recommended?: boolean; command?: string}>;
  command?: string;
}
export function clarificationChoices(input: unknown, plain: unknown = []): ClarificationChoice[] {
  const structured=(Array.isArray(input)?input:[]).filter(q=>typeof q === 'string' ? q.trim() : q && typeof q.question === 'string' && q.question.trim());
  const rows = structured.length ? structured : Array.isArray(plain) ? plain : [];
  return rows.slice(0, 4).flatMap((value, index) => {
    const q = typeof value === 'string' ? {question:value} : value;
    if (!q || typeof q.question !== 'string' || !q.question.trim()) return [];
    const id = typeof q.id === 'string' ? q.id : `followup.${index}`;
    const kind = q.kind === 'action' ? 'action' : 'fact';
    const options = (Array.isArray(q.options) ? q.options : []).filter((o: any) => o && typeof o.id === 'string' && typeof o.label === 'string').map((o: any) => ({id:o.id,label:o.label,...(typeof o.detail === 'string'?{detail:o.detail}:{}),recommended:kind === 'action' && o.recommended === true,...(kind === 'action' && typeof o.command === 'string'?{command:o.command}:{})}));
    if (kind === 'action' && options.length) {
      for (const extra of [{id:'collect.partial',label:'I can only share partial evidence'},{id:'collect.unavailable',label:'I cannot get this right now'}]) {
        if (options.length < 3 && !options.some((option: any)=>option.id === extra.id)) options.push({...extra,recommended:false});
      }
    }
    if (kind === 'fact' && options.length === 2 && !options.some((option: any)=>option.id === 'unsure')) options.push({id:'unsure',label: 'I am not sure',recommended:false});
    if (options.length < 3) return [{id,kind:'action' as const,question:q.question.slice(0,600),allowOther:true,options:[
      {id:'collect.full',label:'I can share the requested evidence',recommended:true,detail:'Paste the actual output next. This selection is not a result.'},
      {id:'collect.partial',label:'I only have part of it'},
      {id:'collect.unavailable',label:'I cannot get this right now'},
    ]}];
    const ordered = options.sort((a: any,b: any) => Number(b.recommended)-Number(a.recommended));
    const unsure = kind === 'fact' ? ordered.find((o: any) => o.id === 'unsure') : undefined;
    const shown = unsure ? [...ordered.filter((o: any) => o.id !== 'unsure').slice(0,2),unsure] : ordered.slice(0,3);
    shown.forEach((o: any,i: number) => {o.recommended = kind === 'action' && i === 0;});
    return [{id,kind,question:q.question.slice(0,600),allowOther:true,options:shown,...(kind === 'action' && typeof q.command === 'string' ? {command:q.command} : {})}];
  });
}

/** Keep the readable and structured forms consistent on every public response. */
export function publicClarificationFields(outcome: Record<string, any>) {
  const choices=clarificationChoices(outcome.clarifyingChoices,outcome.clarifyingQuestions);
  return {clarifyingChoices:choices,clarifyingQuestions:choices.map(question=>question.question)};
}
export function normalizeDiagnosisEnvelope(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.fix && typeof value.fix === 'object') return {...value,fix:{...value.fix,...publicClarificationFields(value.fix)}};
  if (value.outcome && typeof value.outcome === 'object') return {...value,outcome:{...value.outcome,...publicClarificationFields(value.outcome)}};
  return {...value,...publicClarificationFields(value)};
}
