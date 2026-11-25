export const categoryStyle = {
  'thiet-bi-ve-sinh': { icon: 'bath', description: 'Bồn cầu, lavabo, sen tắm' },
  'thiet-bi-bep': { icon: 'stove', description: 'Bếp, chậu rửa, máy hút mùi' },
  'gach-op-lat': { icon: 'tile', description: 'Gạch tường, gạch trang trí' },
  'vat-lieu-nuoc': { icon: 'drop', description: 'Lọc nước, máy nước nóng' },
}

export const typeIcons = {
  'bon-cau': 'toilet', 'bon-tieu': 'toilet', 'nap-bon-cau': 'lid',
  lavabo: 'sink', 'voi-chau': 'faucet', 'sen-tam': 'shower', 'bon-tam': 'bath',
  'phu-kien-phong-tam': 'fixture', 'bep-dien-tu': 'stove', 'chau-rua-chen': 'sink',
  'may-hut-mui': 'hood', 'voi-rua-chen': 'faucet', 'loc-nuoc': 'filter',
  'bon-chua-nuoc': 'tank', 'may-nuoc-nong': 'heater', 'gach-inax-ecocarat': 'tile',
  'gach-op-tuong': 'tile',
}

// Vị trí và logo chỉ dùng để Owner xem bố cục. Danh sách không xác lập chính sách hãng.
export const featuredBrands = ['inax', 'toto', 'elica', 'karofi']
export const featuredSeries = []

// #431, comment 7060330377 §3.4, xác minh chính xác AC-G216VN/BW1.
// Chỉ hiển thị ở chế độ duyệt tỷ lệ khi chưa có đích Series hay ảnh được duyệt.
export const seriesLayoutSample = {
  category: 'thiet-bi-ve-sinh', brand: 'inax', name: 'INAX S600 LINE',
}
