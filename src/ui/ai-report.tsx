import { useEffect, useRef, useState } from 'react';
import type { AiCitation } from '../shared/contracts';

export function AiReport({ report, citations, notice }: { report: string; citations?: AiCitation[]; notice?: string }) {
  const [selected, setSelected] = useState<AiCitation>();
  const preview = useRef<HTMLElement>(null);
  const byId = new Map(citations?.map(citation => [citation.id, citation]));
  useEffect(() => { preview.current?.focus(); }, [selected]);
  return <>
    {notice && <p className="notice">{notice}</p>}
    <div className="ai-report-text">{report.split(/(\[[A-Z]{1,4}:\d{1,10}\])/).map((part, index) => {
      const citation = part.startsWith('[') && part.endsWith(']') ? byId.get(part.slice(1, -1)) : undefined;
      return citation ? <button key={index} type="button" className="ai-citation" aria-label={`查看证据 ${citation.id}`}
        onClick={() => { setSelected(citation); if (selected === citation) preview.current?.focus(); }}>{part}</button> : part;
    })}</div>
    {selected && <section className="ai-citation-detail" tabIndex={-1} ref={preview}
      aria-label="证据定位"><strong>{selected.label}</strong><pre>{selected.text}</pre></section>}
  </>;
}
