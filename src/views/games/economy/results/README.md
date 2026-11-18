# Per-game results screens

`TowerResults.tsx`, `SnakeResults.tsx`, `CometResults.tsx` replace the generic results card for
their game. They take the same props as `ResultsCard` (`types.ts`) and run the same sequence
(`useResults.ts`: hold the chip, reveal rows with ticks, fly the total into the chip, release).
`index.tsx` exports `resultsScreenFor(game)`, which returns `null` for a game without its own
screen.

## Wiring into ResultsCard.tsx (the only edit needed)

1. Add the import at the top:

```ts
import { resultsScreenFor } from "./results";
```

2. Rename the existing component: `export default function ResultsCard({ ... })` becomes
   `function GenericResultsCard({ ... })` (body unchanged).

3. Add the new default export below it:

```tsx
export default function ResultsCard(props: Parameters<typeof GenericResultsCard>[0]) {
  const Screen = resultsScreenFor(props.award.game);
  return Screen ? <Screen {...props} /> : <GenericResultsCard {...props} />;
}
```

`Games.tsx` keeps rendering `<ResultsCard ... />` unchanged, in both places (stage and floating).

## Rank-up trigger

The per-game screens do not run code from `GenericResultsCard`. Anything that must happen after
the coins landed (the rank-up animation) goes through the `onCoinsLanded(award)` prop, which every
screen calls once after the last coin (at once with reduced motion or zero coins). If the trigger
lives inside `ResultsCard`, pass it on in step 3:

```tsx
return Screen ? <Screen {...props} onCoinsLanded={triggerRankUp} /> : <GenericResultsCard {...props} />;
```

## Preview harness (dev only)

With Vite running, open
`/src/views/games/economy/results/__preview__/index.html?game=tower|snake|comet&mode=best|normal|quit&theme=dark|light&trace=1`.
It shows a mock header with the coin chip at the top right; `trace=1` draws the sampled coin
paths. Not a build entry, so it never ships.
