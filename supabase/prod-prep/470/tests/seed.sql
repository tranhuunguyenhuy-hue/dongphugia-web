insert into dpg_app.products(sku,name,slug,category_id,price,list_price,sale_price,original_price,price_state,stock_status) values
 ('VS-OK','VS verified','vs-ok',1,111,111,null,111,'priced','in_stock'),            -- id1: legacy price must be IGNORED after cutover
 ('VS-PROMO','VS promo+voucher','vs-promo',1,222,222,null,222,'priced','in_stock'), -- id2
 ('VS-NOPRICE','VS unverified','vs-nop',1,333,333,null,333,'priced','in_stock'),    -- id3: has LEGACY price but no canonical status
 ('VS-CONTACT','VS contact verified','vs-con',1,444,444,null,444,'priced','in_stock'),-- id4
 ('GL-1','Gach legacy','gl-1',5,500000,500000,450000,500000,'priced','in_stock'),   -- id5: other category stays legacy
 ('VS-OUT','VS out of stock','vs-out',1,null,null,null,null,'unknown','out_of_stock'); -- id6
