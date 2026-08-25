# Cambrio Online — Game Specification v1.0

This document is authoritative. If UI copy or animation conflicts with this specification, the server rules and this document win.

## Round

- One independent round supports 2–8 players. Seating and the first player are randomized server-side; play is clockwise.
- Use one 52-card deck without Jokers. Ace is worth 1; 2–10 use face value; J, Q, and black Kings are worth 10; red Kings are worth −1.
- Deal four hidden cards to each player. The discard pile starts empty. Each player may hold to inspect their two bottom cards once, then confirms readiness.
- Every turn draws privately from the deck. The player either discards the drawn card or replaces one owned card with it; the replaced card becomes the discard.
- A hand is a variable-length collection of stable spatial slots. The starting cards occupy top-left, top-right, bottom-left, and bottom-right. Existing cards never reflow when another card leaves; a vacant slot stays visible. A drawn replacement inherits the replaced card's slot, swaps exchange card identities without moving either table position, and a penalty or gift uses the first open slot.
- A player may own at most six cards. A wrong stack may take a player from five to six cards. A six-card player may still attempt a stack so the cap never traps them; a miss adds no seventh card and locks that player out only for the current discard. A new discard clears the lock.

## Optional powers

Only a card drawn from the deck and immediately discarded offers its power. Replaced, stacked, recycled, and opening cards do not.

| Rank | Power |
| --- | --- |
| 7 or 8 | Hold to inspect one owned card. |
| 9 or 10 | Hold to inspect one opponent card. |
| Jack or Queen | Blindly swap one owned card and one opponent card. |
| Black King | Inspect one owned and one opponent card together, then optionally swap them. |

Every power enters target selection immediately after the power card is discarded. Only legal cards are highlighted, and the acting player may choose **Skip ability**. There is no separate use-power confirmation. With zero cards, 9/10 remains usable and a black King may inspect one opponent card but cannot swap; other powers have no legal effect.

## Stacking

- A normal discard opens one stack race until a later normal discard or one successful stack.
- Any player with at least one owned card, including the discarder, may tap any table card directly while the stack window is open. There is no separate Stack-mode button. Matching uses rank only.
- The first valid request received by the authoritative server wins. A wrong target stays with its owner and the guesser receives one unseen penalty card. The guesser may retry and receives another penalty for each miss.
- A successful card is discarded, closes the race, does not activate a power, and cannot be chained.
- If the stacked card belonged to another player, the stacker must give that player any one of their own remaining cards. The transfer is hidden and mandatory.
- Stacking stays live during powers and does not cancel an already-offered power.

## Board interaction contract

- Every starting hand renders as a fixed 2×2 spatial grid with short TL/TR/BL/BR labels. Penalties never reflow those four positions: the local fifth/sixth cards extend as +1/+2 in a third column on the right, while compact opponent grids retain the same labeled starting geometry and add stable numbered slots when necessary.
- Context determines a single tap without extra modal steps: a highlighted owned slot replaces a drawn card; a highlighted power target selects it; a mandatory gift chooses the card to transfer; otherwise a tap during an open race attempts a stack.
- Card identity is animated continuously when it moves between deck, hand, opponent, and discard. A correct stack travels to the discard and shows a success cue. A wrong stack shakes in place, shows a failure cue, and animates the unseen penalty into the guesser's next slot.
- Private reveals require a press-and-hold gesture. Releasing or moving the app out of focus conceals the cards. Black King shows both selected cards together, then presents only **Swap cards** and **Keep positions**.

## Ending and scoring

- A player may call Cambio at any time during active play. The first call starts ending mode. Reaching zero cards also starts it automatically if it has not begun.
- Finish the current turn, continue clockwise through the triggering player, then complete one full final rotation ending with that player. A trigger during that player's own turn counts that current turn as the first completion.
- Later calls and later zero-card events do not change the ending queue.
- A zero-card player never receives cards or initiates stacks. Required turns draw and immediately discard.
- After the ending queue, reveal and total all cards. Every player tied for the lowest total wins. Calling Cambio has no penalty.
- If the deck empties, retain the top discard and shuffle older discards into the deck. If nothing can be recycled, reveal and score immediately.

## Multiplayer guarantees

- The server owns the deck, hidden card identities, timers, validation, race order, ending queue, and scores. Clients receive only personalized projections.
- Turn actions time out after 45 seconds to a safe draw-discard or declined optional power. Mandatory card gifts time out to a random legal card.
- Any disconnected seated player pauses the entire active round. The server snapshots the exact remaining initial-peek, turn, power, or transfer time; no cards, races, powers, or timeouts can advance while paused. The seat is preserved, and the saved clock resumes only after every non-forfeited player has returned. The host may remove a player as a forfeit instead of waiting.
- Socket rooms detect a dropped transport directly. The free hosted transport uses periodic presence heartbeats and marks a seat disconnected after 18 seconds without one. A hidden or reopened browser with the same identity reclaims the same seat rather than creating a duplicate.
- Removing a player burns their cards unseen. They receive a game played and no win. Host authority transfers to the longest-connected remaining player.
- Rooms return to the lobby after results and expire two hours after becoming empty.
