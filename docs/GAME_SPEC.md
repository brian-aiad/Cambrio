# Cambrio Online — Game Specification v1.0

This document is authoritative. If UI copy or animation conflicts with this specification, the server rules and this document win.

## Round

- One independent round supports 2–8 players. Seating and the first player are randomized server-side; play is clockwise.
- Use one 52-card deck without Jokers. Ace is worth 1; 2–10 use face value; J, Q, and black Kings are worth 10; red Kings are worth −1.
- Deal four hidden cards to each player. The discard pile starts empty. Each player may hold to inspect their two bottom cards once, then confirms readiness.
- Every turn draws privately from the deck. The player either discards the drawn card or replaces one owned card with it; the replaced card becomes the discard.
- A hand is an ordered, variable-length collection. Penalties can grow it and stacks can shrink it.

## Optional powers

Only a card drawn from the deck and immediately discarded offers its power. Replaced, stacked, recycled, and opening cards do not.

| Rank | Power |
| --- | --- |
| 7 or 8 | Hold to inspect one owned card. |
| 9 or 10 | Hold to inspect one opponent card. |
| Jack or Queen | Blindly swap one owned card and one opponent card. |
| Black King | Inspect one owned and one opponent card together, then optionally swap them. |

Every power may be declined. With zero cards, 9/10 remains usable and a black King may inspect one opponent card but cannot swap; other powers have no legal effect.

## Stacking

- A normal discard opens one stack race until a later normal discard or one successful stack.
- Any player with at least one owned card, including the discarder, may arm Stack and target any table card. Matching uses rank only.
- The first valid request received by the authoritative server wins. A wrong target stays with its owner and the guesser receives one unseen penalty card. The guesser may retry and receives another penalty for each miss.
- A successful card is discarded, closes the race, does not activate a power, and cannot be chained.
- If the stacked card belonged to another player, the stacker must give that player any one of their own remaining cards. The transfer is hidden and mandatory.
- Stacking stays live during powers and does not cancel an already-offered power.

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
- A required turn pauses for a disconnected player for 60 seconds, then safe auto-play begins. The player may reconnect; the host may remove them as a forfeit.
- Removing a player burns their cards unseen. They receive a game played and no win. Host authority transfers to the longest-connected remaining player.
- Rooms return to the lobby after results and expire two hours after becoming empty.

