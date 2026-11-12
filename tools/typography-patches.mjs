// The composer info row mixes two of upstream's text systems on one line:
// the neighbours — the effort and mode core-v2 buttons and the mission-role
// chip paragraph — paint a core-v2 line-height of exactly 15px, while the
// model-name chip's own text box does not share that rhythm. On the shared
// chip height the model text's ink sits lower than the ink around it, which
// reads as a crooked row once the chips sit side by side.
//
// The port keeps every other text instance at the upstream rhythm (the
// paragraphs, labels and headings that surround nothing else on their
// line): only the model-name chip's span receives an inline 15px
// line-height, matching the row it renders into. The chip's colour,
// content and the trigger around it stay exactly as upstream shipped them.
//
// Exact anchor from the inspected, checksum-pinned Desktop 1.9.0 renderer
// (the composer model selector trigger, beside the `model-name-shimmer`
// branch). 1.9.0 renders the chip through its Typography call (`Dt`, body-2)
// again, so the anchor follows that call and leaves every other body-2 text
// on the row untouched.
export const typographyRendererChanges = [
  ['composer model chip joins the 15px row line-height',
    'c.jsx(Dt,{color:F?"muted":"default",variant:"body-2",children:rn})',
    'c.jsx(Dt,{color:F?"muted":"default",variant:"body-2",style:{lineHeight:"15px"},children:rn})'],
];
