export type CanteenDish = { id: string; name: string; description: string; priceWei: string; active: boolean };
export type CanteenItem = { dishId: string; name: string; unitPriceWei: string; quantity: number };
export type CanteenOrder = {
  id: string; wallet: string; method: 'WALLET' | 'FOOD'; items: CanteenItem[]; totalWei: string;
  status: 'AWAITING_PAYMENT' | 'EXPIRED' | 'PAID'; createdAt: number; afterBlock: number | null;
  invoiceId: string | null; txHash: string | null; paidAmountWei: string | null;
  merchantAddress?: string | null;
};
