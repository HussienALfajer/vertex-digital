export * from './core/adapter.js';
export { outcomeOfOrderError, SupplierError } from './core/errors.js';
export {
  hmacSha256,
  type SignatureEncoding,
  safeEqual,
  type VerifySignatureInput,
  verifyHmacSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from './core/hmac.js';
export {
  SupplierHttp,
  type SupplierHttpOptions,
  type SupplierReply,
  type SupplierRequest,
} from './core/http.js';
export {
  FAKE_SIGNATURE_HEADER,
  FAKE_SUPPLIER_CODE,
  FAKE_TIMESTAMP_HEADER,
  type FakeAdapterOptions,
  type FakeOrder,
  type FakeOrderScript,
  FakeSupplierAdapter,
  type FakeSupplierState,
  fakeOrderScriptSchema,
  fakeSupplierStateSchema,
} from './fake/adapter.js';
export {
  WDG_SIGNATURE_HEADER,
  WDGZONE_BASE_URL,
  WDGZONE_SUPPLIER_CODE,
  WdgzoneAdapter,
  type WdgzoneAdapterOptions,
} from './wdgzone/adapter.js';
