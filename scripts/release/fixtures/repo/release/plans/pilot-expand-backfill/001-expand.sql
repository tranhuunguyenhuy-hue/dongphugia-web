-- Expand: nullable column, so the old Worker keeps working with the new schema.
alter table dpg_app.products add column price_label text;
