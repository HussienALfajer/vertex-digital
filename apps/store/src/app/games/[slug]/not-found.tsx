import { EarlyAccessGame } from '@/features/catalog/early-access-game';
import NotFound from '../../not-found';

/** S23 OP5: an early-access game for a merchant whose tier sees it; else the usual not found. */
export default function GameNotFound() {
  return (
    <EarlyAccessGame>
      <NotFound />
    </EarlyAccessGame>
  );
}
