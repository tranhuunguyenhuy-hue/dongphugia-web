// Privileges for the dedicated (non-CRUD) handlers in commerce-handlers.ts. Kept next to the resource definitions so the
// generated migration is the single, reviewable description of everything the API role may touch.
import type { ExtraGrant } from './grants.ts'

const ORDER_READ = ['id', 'order_number', 'customer_name', 'customer_phone', 'customer_email', 'customer_address', 'note', 'subtotal', 'shipping_fee', 'discount', 'vat_rate', 'total', 'status', 'payment_method', 'payment_status', 'created_at', 'updated_at', 'assigned_to', 'assigned_at']
const QUOTE_READ = ['id', 'quote_number', 'name', 'phone', 'email', 'message', 'status', 'created_at', 'updated_at', 'admin_notes', 'shipping_fee', 'vat_rate', 'assigned_to', 'customer_id']

export const CUSTOM_GRANTS: ExtraGrant[] = [
  // Orders: staff change status/payment/assignment and the pricing fields; creation and deletion are not part of the Admin.
  { table: 'orders', select: ORDER_READ, update: ['status', 'payment_status', 'assigned_to', 'assigned_at', 'vat_rate', 'shipping_fee', 'discount', 'note', 'subtotal', 'total', 'updated_at'] },
  { table: 'order_items', select: ['id', 'order_id', 'product_id', 'product_name', 'product_sku', 'quantity', 'unit_price', 'total_price'], update: ['unit_price', 'quantity', 'total_price'] },
  // Quotes: status, assignment and the builder fields; the customer's own request (name, phone, items) is read-only.
  { table: 'quote_requests', select: QUOTE_READ, update: ['status', 'assigned_to', 'admin_notes', 'shipping_fee', 'vat_rate', 'customer_id', 'updated_at'] },
  // Completing a quote links/creates the customer (CSKH): the interaction timestamp is touched by that flow only.
  { table: 'customers', update: ['last_interacted_at'] },
  // Variant groups (legacy link/unlink variant): the grouping column of products is touched only by those two flows.
  { table: 'products', select: ['variant_group'], update: ['variant_group'] },
  { table: 'quote_items', select: ['id', 'quote_id', 'product_id', 'quantity', 'note', 'admin_quantity', 'admin_unit_price', 'product_sku_snapshot', 'product_name_snapshot', 'snapshot_at', 'list_price_snapshot', 'sale_price_snapshot'], update: ['admin_quantity', 'admin_unit_price'] },
]
