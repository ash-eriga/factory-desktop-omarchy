// The composer info row mixes two of upstream's text systems on one line:
// the model-name chip renders through the app Typography component (base
// line-height from its `y4n` config is 1.2, so 14.4px at 12px) while every
// neighbour — the effort and mode core-v2 buttons and the mission-role chip
// paragraph — paints a core-v2 line-height of exactly 15px. On the shared
// chip height the model text's ink sits ~0.3px lower than the ink around it,
// which reads as a crooked row once the chips sit side by side.
//
// The port keeps every other Typography instance at the upstream 1.2 rhythm
// (the paragraphs, labels and headings that surround nothing else on their
// line): the base config stays untouched, and only the model-name chip's
// Typography call receives an inline 15px line-height, matching the row it
// renders into. The chip's colour, variant, letter-spacing and content stay
// exactly as upstream shipped them.
//
// Exact anchor from the inspected, checksum-pinned Desktop 1.5.0 renderer
// (the composer model selector trigger, beside the `model-name-shimmer`
// branch). The `S7i` Typography helper forwards rest props, so the inline
// style reaches the rendered span.
export const typographyRendererChanges = [
  ['composer model chip joins the 15px row line-height',
    'variant:"body-2",children:Jn})',
    'variant:"body-2",style:{lineHeight:"15px"},children:Jn})'],
];
