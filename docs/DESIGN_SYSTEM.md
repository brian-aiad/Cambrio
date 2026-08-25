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

The custom Cambrio mark is a pair of offset cards connected by opposing arrows: a hand changes, but position and memory remain. It deliberately avoids a generic letter monogram. The mark and game-action symbols are inline SVG so they remain crisp and color-consistent at every device scale. Lucide is limited to familiar utility controls such as sound, copy, close, and profile.

Card faces also use code-native SVG suit marks rather than operating-system suit glyphs. This keeps Hearts, Diamonds, Clubs, and Spades crisp and correctly proportioned from a compressed eight-player rail through the full-size local hand. Ranks use a restrained card-face type treatment so Q, 10, and the other crowded corners remain immediately legible.

## Spatial memory

- Starting slots are always TL, TR, BL, BR. Removing or replacing a card never moves the other identities.
- Fifth and sixth local cards occupy stable +1/+2 positions without reordering TL/TR/BL/BR.
- Seven opponents use one compressed mobile rail and one desktop/landscape row. Seat order and each opponent's TL/TR/BL/BR geometry never change.
- Empty slots remain outlined and labeled. The absence of a card is meaningful game information.

## Direct interaction

- Tap the deck to draw.
- After a draw, tap **Discard** or tap one highlighted owned slot to replace it.
- During an open stack race, tap any remembered table card directly. There is no stack-mode button and no player-selection modal.
- Power cards immediately mark only legal targets. A compact numbered action strip shows the completed and current step; the selected source stays visibly numbered on the physical card, so Jack/Queen and Black King never depend on a sentence to explain what happens next. Dense eight-player rails keep the step strip but remove repeated number badges from every eligible opponent card.
- Peeks reveal immediately after one legal card tap, remain visible for a short timed memory window, then conceal and complete automatically. Leaving or blurring the window conceals immediately.
- Black King selects one owned card and then one opponent card, reveals both for the same timed memory window, then offers **Swap** or **Keep**.
- The Black King decision is a distinct concealed server state: both ranks are removed from the browser projection before **Swap** or **Keep** appears.
- Action hit areas never translate while awaiting input. The deck signals readiness with light and shadow only, so a fast touch, keyboard activation, and browser automation all acquire the same stable target.
- A full mobile lobby becomes a two-column eight-seat grid with a visible capacity meter and an on-screen deal/ready control, including at 320×568. Join, ready, remove, draw, discard, target, and decision taps show a local pending state while waiting for the authoritative acknowledgement.

## Motion and feedback

- A card identity keeps a shared layout identity while moving between slots and piles; the animation communicates the state change instead of decorating it.
- Blind swaps and Black King exchanges animate two numbered, face-down cards between their exact player and slot endpoints. Both destinations remain empty until the crossing cards arrive, so there is no ambiguous duplicate state.
- A normal hand replacement and a successful stack animate from the exact source slot to discard. The travelling card turns face-up before arrival, making the public card change observable to every player.
- Cambrio and zero-card endings occupy the permanent turn-status column with the current player and remaining-turn count; they never cover an opponent card.
- Notices belong to the screen that created them. Spatial swaps, deal instructions, ending calls, and rematch confirmation use their native table/lobby state instead of duplicate toasts over the hand.
- Correct stack: selected card lifts/scales, travels to discard, success cue remains long enough to read.
- Wrong stack: selected card shakes in place, penalty occupies the next stable slot, and an explicit penalty cue remains visible for 1.5 seconds.
- Drawn cards enter from the deck side; prompt surfaces use short spring transitions without bounce-heavy staging.
- Reduced-motion users receive near-instant state changes with the same textual and color feedback.
- Native vibration, when available, is brief and consistent: selection, success, and wrong-stack patterns are distinct. Visual feedback never depends on haptics.

## Accessibility and input safety

- Primary controls meet the 44px iPhone convention; game cards remain large direct targets in normal portrait play. The narrowest landscape compaction still preserves readable labels and full card height.
- The mobile table respects iPhone notch and home-indicator safe areas and suppresses page overscroll, keeping rapid stack taps inside the game surface.
- Every hidden card has an accessible spatial name (for example, “bottom left card”), and interactive states add “tap to select.”
- Focus uses the same mint target language as touch highlighting. Color is always paired with copy, shape, or motion.
- Duplicate client decisions are locked while awaiting acknowledgement. The server additionally coalesces identical in-flight action IDs, rate-limits guess spam, and remains authoritative for every result.
- A temporary transport failure keeps the table visible in a **Reconnecting** state. Recovery restores the same server-owned seat; only session initialization failures use the fatal screen.
- Full or active tables use a dedicated queue screen with a stable position, seated-player count, explicit departure, and automatic promotion when a seat becomes available.
- A host removal invalidates that socket’s membership and returns the removed player home with a short explanation; no client remains on a stale table.
- Turn and power decisions carry the authoritative game version. Delayed packets are rejected, while stack attempts remain tied to their discard generation so the realtime race stays fair.

## Reference principles

The implementation follows direct-manipulation, contextual-control, feedback, accessibility, and haptic guidance from [Apple's game controls](https://developer.apple.com/design/human-interface-guidelines/game-controls), [Apple's games guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-games), [Apple accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), and [Apple haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics). Target sizing follows [WCAG 2.2 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Card movement uses [Motion shared layout transitions](https://motion.dev/docs/react-layout-animations).
