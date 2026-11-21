-- M6 (#432) Staging/TEST fixtures ONLY: public manufacturer codes (no price, no stock, no image, no internal data).
-- Names are brand + code. Slugs are prefixed fx-. Idempotent. Rollback: 002_m6_series_fixtures_rollback.sql
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where environment='preview_synthetic' and production_writes_allowed=false and production_data_allowed=false) then
    raise exception 'M6_TARGET_GUARD_FAILED:not_the_synthetic_staging_target';
  end if;
end $$;

insert into dpg_app.brands(name,slug,is_active) select 'TOTO','toto',true where not exists (select 1 from dpg_app.brands where slug='toto');
insert into dpg_app.brands(name,slug,is_active) select 'INAX','inax',true where not exists (select 1 from dpg_app.brands where slug='inax');
insert into dpg_app.subcategories(category_id,name,slug,is_active)
select c.id,v.n,v.s,true from dpg_app.categories c cross join (values ('sen-tam','Sen Tắm'),('voi-chau','Vòi Chậu')) v(s,n)
where c.slug='thiet-bi-ve-sinh' and not exists (select 1 from dpg_app.subcategories x where x.category_id=c.id and x.slug=v.s);
with src(sku,brand,sub,slug,vg,label,act,lv,legacy) as (values
  ('TLG11201B','toto','voi-chau','fx-toto-tlg11201b','TLG11201B','Chrome',true,'default','GF Series'),
  ('TLG11201B#PN','toto','voi-chau','fx-toto-tlg11201b-pn','TLG11201B','Niken',true,'default','GF Series'),
  ('TLG11201B#BN','toto','voi-chau','fx-toto-tlg11201b-bn','TLG11201B','Nickel Mờ',true,'default','GF Series'),
  ('TLG11201B#PFG','toto','voi-chau','fx-toto-tlg11201b-pfg','TLG11201B','Vàng Bóng',true,'default','GF Series'),
  ('TLG11201B#BFG','toto','voi-chau','fx-toto-tlg11201b-bfg','TLG11201B','Vàng Mờ',true,'default','GF Series'),
  ('TLG11201B#PBR','toto','voi-chau','fx-toto-tlg11201b-pbr','TLG11201B','Đồng',true,'default','GF Series'),
  ('TLG11201B#BBR','toto','voi-chau','fx-toto-tlg11201b-bbr','TLG11201B','Đồng Mờ',true,'default','GF Series'),
  ('TLG11201B#MBL','toto','voi-chau','fx-toto-tlg11201b-mbl','TLG11201B','Đen Mờ',false,'search_only','GF Series'),
  ('FX-XBRAND-001','preview-synthetic','voi-chau','fx-preview-synthetic-fx-xbrand-001','TLG11201B','Khác hãng',true,'default',null),
  ('FX-XSUB-001','toto','sen-tam','fx-toto-fx-xsub-001','TLG11201B','Khác danh mục',true,'default',null),
  ('CS735DE2#XW','toto','bon-cau','fx-toto-cs735de2-xw','CS735D','Nắp rửa cơ E2',true,'default',null),
  ('CS735DE4#XW','toto','bon-cau','fx-toto-cs735de4-xw','CS735D','Nắp rửa cơ E4',true,'default',null),
  ('CS735DT3#XW','toto','bon-cau','fx-toto-cs735dt3-xw','CS735D','Nắp đóng êm T3',true,'default',null),
  ('CS735DT2#XW','toto','bon-cau','fx-toto-cs735dt2-xw','CS735D','Nắp đóng êm T2',true,'default',null),
  ('CS735DT8#XW','toto','bon-cau','fx-toto-cs735dt8-xw','CS735D','Nắp đóng êm T8',true,'default',null),
  ('CS735DW14#XW','toto','bon-cau','fx-toto-cs735dw14-xw','CS735D','Nắp điện tử W14',true,'default',null),
  ('CS735DT10#XW','toto','bon-cau','fx-toto-cs735dt10-xw','CS735D','Nắp đóng êm T10',true,'default',null),
  ('CS735DW16#XW','toto','bon-cau','fx-toto-cs735dw16-xw','CS735D','Nắp điện tử W16',true,'default',null),
  ('CS735DW11#XW','toto','bon-cau','fx-toto-cs735dw11-xw','CS735D','Nắp điện tử W11',true,'low_priority',null),
  ('CS735DW7#XW','toto','bon-cau','fx-toto-cs735dw7-xw','CS735D','CS735DW7#XW',false,'search_only',null),
  ('CS735DW6#XW','toto','bon-cau','fx-toto-cs735dw6-xw','CS735D','CS735DW6#XW',false,'search_only',null),
  ('TLG11307BA','toto','voi-chau','fx-toto-tlg11307ba',null,null,true,'default','GF Series'),
  ('TLG11308BA','toto','voi-chau','fx-toto-tlg11308ba',null,null,true,'default','GF Series'),
  ('TLG07301V','toto','voi-chau','fx-toto-tlg07301v',null,null,true,'default','GE Series'),
  ('TLG07303V','toto','voi-chau','fx-toto-tlg07303v',null,null,true,'default','GE Series'),
  ('TLG02310BB','toto','voi-chau','fx-toto-tlg02310bb',null,null,true,'default','GR Series'),
  ('TLG08301V','toto','voi-chau','fx-toto-tlg08301v',null,null,true,'default','GC Series'),
  ('TX109LD','toto','voi-chau','fx-toto-tx109ld',null,null,true,'default',null),
  ('TLG08308BA','toto','voi-chau','fx-toto-tlg08308ba',null,null,true,'default','GS Series'),
  ('TLG08308BA#BN','toto','voi-chau','fx-toto-tlg08308ba-bn',null,null,true,'default','GS Series'),
  ('TBG11303V','toto','sen-tam','fx-toto-tbg11303v',null,null,true,'default',null),
  ('TBG07302VA','toto','sen-tam','fx-toto-tbg07302va','TBG07302','Không gồm tay sen',true,'default','GE Series'),
  ('TBG07303VA','toto','sen-tam','fx-toto-tbg07303va',null,null,true,'default',null),
  ('TBG02303BA','toto','sen-tam','fx-toto-tbg02303ba',null,null,true,'default',null),
  ('TBG07302VA/TBW01010A','toto','sen-tam','fx-toto-tbg07302va-tbw01010a','TBG07302','Bộ tay sen 01010A',true,'default',null),
  ('TBG07302VA/TBW02005A','toto','sen-tam','fx-toto-tbg07302va-tbw02005a','TBG07302','Bộ tay sen 02005A',true,'default',null),
  ('TBG07302VA/TBW02006A','toto','sen-tam','fx-toto-tbg07302va-tbw02006a','TBG07302','Bộ tay sen 02006A',true,'default',null),
  ('TBG07302VA/TBW02017A','toto','sen-tam','fx-toto-tbg07302va-tbw02017a','TBG07302','Bộ tay sen 02017A',true,'default',null),
  ('TBG07302VA/DGH104ZR','toto','sen-tam','fx-toto-tbg07302va-dgh104zr','TBG07302','Bộ tay sen 104ZR',true,'default',null),
  ('TBG07302VA/DGH108ZR','toto','sen-tam','fx-toto-tbg07302va-dgh108zr','TBG07302','Bộ tay sen 108ZR',true,'default',null),
  ('TBG07302VA/TBW01008A','toto','sen-tam','fx-toto-tbg07302va-tbw01008a','TBG07302','Bộ tay sen 01008A',true,'default',null),
  ('TBW01001BA','toto','sen-tam','fx-toto-tbw01001ba','TBW01001B',null,true,'default','G Selection'),
  ('TBW01001BA/TBS02302V/TBW01008A','toto','sen-tam','fx-toto-tbw01001ba-tbs02302v-tbw01008a','TBW01001B',null,true,'default','GO Series'),
  ('TBW01001BA/TBG01302VA/DGH108ZR','toto','sen-tam','fx-toto-tbw01001ba-tbg01302va-dgh108zr','TBW01001B',null,true,'default','GS Series'),
  ('AC-G216VN/BW1','inax','bon-cau','fx-inax-ac-g216vn-bw1','AC-G216VN','Trắng',true,'default','Satis G'),
  ('AC-G216VN/BKG-DEN','inax','bon-cau','fx-inax-ac-g216vn-bkg-den','AC-G216VN','Đen',false,'search_only','Satis G'),
  ('ACT-902VN/BW1','inax','bon-cau','fx-inax-act-902vn-bw1','ACT-902','Nắp đóng êm',true,'default','S200'),
  ('ACT-902+CW-S15VN/BW1','inax','bon-cau','fx-inax-act-902-cw-s15vn-bw1','ACT-902','Nắp rửa cơ S15',true,'default','S200'),
  ('ACT-902+CW-S32VN/BW1','inax','bon-cau','fx-inax-act-902-cw-s32vn-bw1','ACT-902','Nắp rửa cơ S32',true,'default','S200'),
  ('ACT-902+CW-H17VN/BW1','inax','bon-cau','fx-inax-act-902-cw-h17vn-bw1','ACT-902','Nắp điện tử H17',true,'default','S200'),
  ('ACT-902+CW-H18VN/BW1','inax','bon-cau','fx-inax-act-902-cw-h18vn-bw1','ACT-902','Nắp điện tử H18',true,'default','S200'),
  ('ACT-902+CW-KB22AVN/BW1','inax','bon-cau','fx-inax-act-902-cw-kb22avn-bw1','ACT-902','Nắp điện tử KB22',true,'default','S200'),
  ('ACT-902+CW-KA22AVN/BW1','inax','bon-cau','fx-inax-act-902-cw-ka22avn-bw1','ACT-902','Nắp điện tử KA22',true,'default','S200'),
  ('ACT-902+CW-H20VN/BW1','inax','bon-cau','fx-inax-act-902-cw-h20vn-bw1','ACT-902','Nắp điện tử H20',true,'default','S200'))
insert into dpg_app.products(sku,name,slug,category_id,subcategory_id,brand_id,variant_group,variant_label,is_active,listing_visibility,source_system)
select s.sku, upper(s.brand)||' '||s.sku, s.slug, c.id, sc.id, b.id, s.vg, s.label, s.act, s.lv, 'fixture-432'
from src s join dpg_app.categories c on c.slug='thiet-bi-ve-sinh'
join dpg_app.subcategories sc on sc.category_id=c.id and sc.slug=s.sub join dpg_app.brands b on b.slug=s.brand
where not exists (select 1 from dpg_app.products p where p.sku=s.sku);
-- Legacy (Hita-style) free-text series values: kept as-is, never promoted to a tag without a verified mapping.
insert into dpg_app.product_spec_values(product_id,spec_definition_id,value_text,source,confidence)
select p.id,d.id,s.legacy,'legacy-text','medium'
from (values ('TLG11201B','GF Series'),('TLG11201B#PN','GF Series'),('TLG11201B#BN','GF Series'),('TLG11201B#PFG','GF Series'),('TLG11201B#BFG','GF Series'),('TLG11201B#PBR','GF Series'),('TLG11201B#BBR','GF Series'),('TLG11201B#MBL','GF Series'),('TLG11307BA','GF Series'),('TLG11308BA','GF Series'),('TLG07301V','GE Series'),('TLG07303V','GE Series'),('TLG02310BB','GR Series'),('TLG08301V','GC Series'),('TLG08308BA','GS Series'),('TLG08308BA#BN','GS Series'),('TBG07302VA','GE Series'),('TBW01001BA','G Selection'),('TBW01001BA/TBS02302V/TBW01008A','GO Series'),('TBW01001BA/TBG01302VA/DGH108ZR','GS Series'),('AC-G216VN/BW1','Satis G'),('AC-G216VN/BKG-DEN','Satis G'),('ACT-902VN/BW1','S200'),('ACT-902+CW-S15VN/BW1','S200'),('ACT-902+CW-S32VN/BW1','S200'),('ACT-902+CW-H17VN/BW1','S200'),('ACT-902+CW-H18VN/BW1','S200'),('ACT-902+CW-KB22AVN/BW1','S200'),('ACT-902+CW-KA22AVN/BW1','S200'),('ACT-902+CW-H20VN/BW1','S200')) s(sku,legacy)
join dpg_app.products p on p.sku=s.sku and p.source_system='fixture-432'
join dpg_app.spec_definitions d on d.key='Bộ sưu tập'
where not exists (select 1 from dpg_app.product_spec_values v where v.product_id=p.id and v.spec_definition_id=d.id);
