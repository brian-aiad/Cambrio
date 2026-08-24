# Cambrio interaction and visual system

Cambrio should feel like a focused native card game, not a themed casino page. The table is the product. Branding and settings stay compact so names, remembered positions, discard state, and the local hand receive most of the screen.

## Visual language

- **Ink** `#1b1d36` / `#25293d`: navigation, type, card outlines, and the darkest feedback surfaces.
- **Table indigo** `#42457f` / `#343665`: a quiet woven-grid playing surface. No glow, faux wood, gold filigree, glass gradients, or ornamental texture.
- **Action violet** `#5c56c8`: primary decisions and Cambrio. Violet is never used as a decorative page wash.
- **Card blue** `#5aa6e8`: every hidden card and deck back, paired with deep-indigo line work and a white center.
- **Signal mint** `#68d7b2` / `#239172`: current turn, legal targets, connection, and successful actions.
- **Error red** `#c94b56`: wrong stacks, urgent timers, removal, and destructive feedback only.
- **Cool neutral** `#f3f5fa` / white: lobby, onboarding, prompts, and face-up cards. Beige is not part of the palette.

The custom Cambrio mark is a card plus a broken circular loop: memory, return, and a changing hand. The mark and game-action symbols are inline SVG so they remain crisp and color-consistent at every device scale. Lucide is limited to familiar utility controls such as sound, copy, close, and profile.

## Spatial memory

- Starting slots are always TL, TR, BL, BR. Removing or replacing a card never moves the other identities.
- Fifth and sixth local cards become a right-side +1/+2 column. This preserves the original 2×2 block and keeps a six-card hand to two rows.
- Seven opponents use one desktop row, a four-plus-three mobile grid, and one landscape row. Each opponent remains in seat order.
- Empty slots remain outlined and labeled. The absence of a card is meaningful game information.

## Direct interaction

- Tap the deck to draw.
- After a draw, tap **Discard drawn card** or tap one highlighted owned slot to replace it.
- During an open stack race, tap any remembered table card directly. There is no stack-mode button and no player-selection modal.
- Power cards immediately highlight only legal targets. Prompts state the single next action and offer the quieter **Skip ability** escape.
- Peeks use press-and-hold. Blur, pointer cancellation, or release conceals private information immediately.
- Black King selects own card, then opponent card, reveals both only while held, then offers **Swap cards** or **Keep positions**.

## Motion and feedback

- A card identity keeps a shared layout identity while moving between slots and piles; the animation communicates the state change instead of decorating it.
- Correct stack: selected card lifts/scales, travels to discard, success cue remains long enough to read.
- Wrong stack: selected card shakes in place, penalty occupies the next stable slot, and an explicit penalty cue remains visible for 1.5 seconds.
- Drawn cards enter from the deck side; prompt surfaces use short spring transitions without bounce-heavy staging.
- Reduced-motion users receive near-instant state changes with the same textual and color feedback.
- Native vibration, when available, is brief and consistent: selection, success, and wrong-stack patterns are distinct. Visual feedback never depends on haptics.

## Accessibility and input safety

- Primary controls meet the 44px iPhone convention; game cards remain large direct targets in normal portrait play. The narrowest landscape compaction still preserves readable labels and full card height.
- Every hidden card has an accessible spatial name (for example, “bottom left card”), and interactive states add “tap to select.”
- Focus uses the same mint target language as touch highlighting. Color is always paired with copy, shape, or motion.
- Duplicate client decisions are locked while awaiting acknowledgement. The server additionally coalesces identical in-flight action IDs, rate-limits guess spam, and remains authoritative for every result.

## Reference principles

The implementation follows direct-manipulation, contextual-control, feedback, accessibility, and haptic guidance from [Apple's game controls](https://developer.apple.com/design/human-interface-guidelines/game-controls), [Apple's games guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-games), [Apple accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), and [Apple haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics). Target sizing follows [WCAG 2.2 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Card movement uses [Motion shared layout transitions](https://motion.dev/docs/react-layout-animations).
