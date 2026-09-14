export type Environment = 'sandbox' | 'live';

/** 서버 응답 envelope. 성공이면 errorCode/errors/fieldErrors 는 없다 */
export interface Envelope<T> {
  success: boolean;
  message: string;
  data: T | null;
  errorCode?: string;
  errors?: string[];
  fieldErrors?: FieldError[];
  /** 목록 응답에만 */
  pagination?: Pagination;
}

export interface FieldError {
  field: string;
  message: string;
  currentValue?: unknown;
  requiredValue?: unknown;
  constraint?: 'min' | 'max' | 'increment' | 'enum' | 'pattern' | 'required' | string;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  hasNext: boolean;
}

export interface PageMeta {
  currentPageCount: number;
  pageMin: number;
  pageMax: number;
  pageIncrement: number;
  isValid: boolean;
}

// ---------------------------------------------------------------- BookSpecs

export interface SpineWidthRule {
  minPage: number;
  maxPage: number;
  spineWidthMm: number;
}

/** GET /book-specs 의 항목 */
export interface BookSpec {
  bookSpecUid: string;
  name: string;
  innerTrimWidthMm: number;
  innerTrimHeightMm: number;
  pageMin: number;
  pageMax: number;
  pageIncrement: number;
  pageDefault?: number;
  booksPerBox?: number;
  coverType: 'Hardcover' | 'Softcover' | string;
  bindingType: string;
  priceCurrency?: string;
  /** 인증 없이 조회하면 null */
  priceBase: number | null;
  pricePerIncrement: number | null;
  sandboxPriceBase?: number | null;
  sandboxPricePerIncrement?: number | null;
  bleedMm?: number;
  spineWidthRules?: SpineWidthRule[];
}

export interface CalculatedSize {
  bookSpecUid: string;
  pages: number;
  unit: 'mm' | string;
  coverWidthMm: number;
  coverHeightMm: number;
  innerWidthMm: number;
  innerHeightMm: number;
  spineWidthMm: number;
  pdfToleranceMm: number;
}

// ---------------------------------------------------------------- Books

export interface CreateBookRequest {
  /** 1~255자 */
  title: string;
  bookSpecUid: string;
  creationType: 'PDF_UPLOAD';
  /** 내지 페이지 수. 판형 규칙(최소·최대·단위)에 맞아야 한다 */
  pageCount: number;
  /** 파트너 외부 참조, 100자 이하 */
  externalRef?: string;
}

export interface CreateBookResponse {
  bookUid: string;
  pageMeta: PageMeta;
}

/** 단건 조회. status 는 정수(1 DRAFT / 2 FINALIZED) — 목록과 다르다 */
export interface BookDetail {
  bookUid: string;
  accountUid: string;
  title: string;
  bookSpecUid: string;
  bookSpecName: string;
  specProfileUid: string | null;
  creationType: string;
  status: number;
  coverTemplateUid: string | null;
  externalRef: string | null;
  isTest: boolean;
  pageMeta: PageMeta;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

/** 목록 조회 항목. status 는 문자열("draft"/"finalized") — 단건과 다르다 */
export interface BookListItem {
  bookUid: string;
  title: string;
  status: string;
  pageCount: number;
  bookSpecUid: string;
  creationType: string;
  externalRef: string | null;
  isTest: boolean;
  /** null 미생성 / 2 COMPLETED / 9 FAILED. finalize 전에는 null */
  pdfStatus: number | null;
  pdfCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 정규화된 책 상태 — 서버의 세 가지 표기(정수·정수·문자열)를 하나로 */
export type BookStatus = 'DRAFT' | 'FINALIZED' | 'DELETED' | 'UNKNOWN';

// ---------------------------------------------------------------- Finalization

/** POST /books/{uid}/finalization 응답. 첫 호출 201 "created" / 이미 최종화된 책 200 "updated" — 둘 다 성공 */
export interface FinalizeResponse {
  result: 'created' | 'updated' | string;
  pageMeta: PageMeta;
  finalizedAt: string;
}

// ---------------------------------------------------------------- Orders

export interface OrderItemRequest {
  bookUid: string;
  quantity: number;
}

export interface EstimateRequest {
  items: OrderItemRequest[];
}

export interface EstimateItem {
  bookUid: string;
  bookSpecUid: string;
  pageCount: number;
  quantity: number;
  unitPrice: number;
  itemAmount: number;
  packagingFee: number;
}

/**
 * 견적. 금액은 소수점 있는 수(12600.00)로 온다.
 * paidCreditAmount = floor(totalAmount × 1.1 / 10) × 10 — 실제 차감액 (VAT 포함, 10원 절사).
 * creditSufficient 가 false 면 주문은 402 로 끝난다.
 */
export interface EstimateResponse {
  items: EstimateItem[];
  productAmount: number;
  shippingFee: number;
  boxCount: number;
  packagingFee: number;
  totalAmount: number;
  paidCreditAmount: number;
  creditBalance: number;
  creditSufficient: boolean;
  currency: string;
}

export interface ShippingRequest {
  recipientName: string;
  recipientPhone: string;
  postalCode: string;
  address1: string;
  address2?: string;
  memo?: string;
}

export interface CreateOrderRequest {
  items: OrderItemRequest[];
  shipping: ShippingRequest;
  /** 파트너 외부 참조, 100자 이하 */
  externalRef?: string;
}

export interface OrderItem {
  itemUid: string;
  bookUid: string;
  bookTitle: string;
  bookSpecUid: string;
  bookSpecName: string;
  quantity: number;
  pageCount: number;
  unitPrice: number;
  itemAmount: number;
  itemStatus: string;
  itemStatusDisplay: string;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  shippedAt: string | null;
  createdAt: string;
}

/** POST /orders · POST /orders/{uid}/cancel 응답 */
export interface Order {
  orderUid: string;
  accountUid: string;
  accountName: string;
  accountOrganizationName: string | null;
  orderType: string;
  externalRef: string | null;
  /** "PDF_READY"(PDF 책은 주문 즉시) · "CANCELLED_REFUND" 등 */
  orderStatus: string;
  orderStatusDisplay: string;
  isTest: boolean;
  totalProductAmount: number;
  totalShippingFee: number;
  totalPackagingFee: number;
  totalAmount: number;
  paidCreditAmount: number;
  paymentMethod: string;
  /** 취소 응답에서는 null */
  creditBalanceAfter: number | null;
  recipientName: string;
  recipientPhone: string;
  postalCode: string;
  address1: string;
  address2: string | null;
  shippingMemo: string | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  cancelReason: string | null;
  refundAmount: number | null;
  orderedAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  items: OrderItem[];
}

/** 402 ERR_INSUFFICIENT_CREDIT 의 data */
export interface InsufficientCreditData {
  required: number;
  balance: number;
  currency: string;
}

/**
 * GET /credits · POST /credits/sandbox/charge 의 data.
 * balance 는 소수(99000.00)로 온다. env 는 sandbox 계정이면 "test" 다.
 */
export interface CreditAccount {
  accountUid: string;
  balance: number;
  currency: string;
  env: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /credits/sandbox/charge 요청. memo 는 200자 이하 */
export interface SandboxChargeRequest {
  amount: number;
  memo?: string;
}
