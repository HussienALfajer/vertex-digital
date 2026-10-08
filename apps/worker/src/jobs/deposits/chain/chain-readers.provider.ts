import type { Provider } from '@nestjs/common';
import { ENV, type Env } from '../../../core/config/env.js';
import { BscReader } from './bsc-reader.js';
import { CHAIN_READERS, type ChainReaders } from './chain-reader.js';
import { FakeReader, FileFakeChainStore } from './fake-reader.js';
import { TronReader } from './tron-reader.js';

/**
 * The reader of each network, by `CHAIN_READER` (S04): `live` reads TronGrid and the BSC
 * provider; `fake` reads FAKE_CHAIN_FILE (the environment refuses it in production). A network
 * without its address (or its provider) is never read: the scanner skips it.
 */
export const chainReadersProvider: Provider = {
  provide: CHAIN_READERS,
  inject: [ENV],
  useFactory: (env: Env): ChainReaders => {
    if (env.CHAIN_READER === 'fake') {
      const store = new FileFakeChainStore(env.FAKE_CHAIN_FILE);
      return {
        usdt_trc20: new FakeReader('usdt_trc20', store),
        usdt_bep20: new FakeReader('usdt_bep20', store),
      };
    }
    return {
      usdt_trc20: new TronReader({ apiUrl: env.TRONGRID_API_URL, apiKey: env.TRONGRID_API_KEY }),
      // The environment requires BSC_RPC_URL whenever the BSC address is set.
      usdt_bep20: new BscReader({ rpcUrl: env.BSC_RPC_URL ?? 'https://bsc-rpc.invalid' }),
    };
  },
};
