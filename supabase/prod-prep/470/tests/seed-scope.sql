-- extra rows for the brand/state scope tests of 003/004 (run-local.sh only)
insert into dpg_app.brands(slug,name) values ('khac','Hãng khác (không thuộc đợt giá)');   -- brand id 3: sanitary but NOT TOTO/INAX
insert into dpg_app.products(sku,name,slug,category_id,brand_id,price,list_price,sale_price,original_price,price_state,stock_status,is_active) values
 ('VS-INAX','VS INAX verified','vs-inax',1,2,777,777,null,777,'priced','in_stock',true),            -- id7: INAX canonical
 ('VS-OTHERBRAND','VS other sanitary brand','vs-other',1,3,700000,700000,650000,700000,'priced','in_stock',true), -- id8: out of scope -> legacy
 ('VS-INACTIVE','VS TOTO inactive','vs-inactive',1,1,555,555,null,555,'priced','in_stock',false),   -- id9: inactive
 ('VS-INAX-UNRES','VS INAX unresolved','vs-inax-un',1,2,888,888,null,888,'priced','in_stock',true); -- id10: INAX unresolved
