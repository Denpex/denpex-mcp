// WO-3.6, tier → human label, MIRROR of src/lib/tier-label.ts.
//
// The MCP ships as its own npm package (`denpex-mcp`) with its own tsconfig and its
// own bundle; it cannot import from the Next.js app's `src/`. So this is a deliberate
// copy, and `mcp/__tests__/tier-label-sync.test.ts` reads BOTH files and fails if the
// two maps ever disagree, the same guard the repo already uses for the corpus counts
// and the failures matcher.
//
// Why it matters here: the MCP previously printed the raw `meta.source` string
// ("pattern", "keyword_match", "scale_detector"), so an agent and a human looking at
// the same diagnosis in two surfaces saw two different names for the same tier.
//
// The engine emits exactly these tier values. There is NO tier 3.
export function tierLabel(tier?: number): string {
  switch (tier) {
    case 0: return "Scale Detector";
    case 1: return "Pattern Match";
    case 1.5: return "Encyclopedia";
    case 1.6: return "Keyword Match";
    case 2: return "Community Fix";
    case 4: return "Deep Analysis";
    default: return "Live diagnosis";
  }
}
