export const publicOrigin = 'https://www.dongphugia.vn'
export const canonicalProduct = /^\/(?:thiet-bi-ve-sinh|thiet-bi-bep|vat-lieu-nuoc|gach-op-lat)\/[a-z0-9-]+\/[a-z0-9-]+$/

export function makeCatalogue(snapshot) {
  const { categories, brands } = snapshot
  function types(category, brand) {
    return category.types.filter(type => !brand || type.brands.includes(brand))
  }
  function categoriesFor(brand) {
    return categories.filter(category => types(category, brand).length)
  }
  function brandsFor(category) {
    return brands.filter(brand => types(category, brand.slug).length)
  }
  function listing(category, type, brand = '') {
    if (!types(category, brand).includes(type)) return null
    const query = brand ? '?' + new URLSearchParams({ brand }) : ''
    return `${publicOrigin}/${category.slug}/${type.slug}${query}`
  }
  function all(category, brand = '') {
    if (category && !brand && category.publicRoot) return publicOrigin + '/' + category.slug
    if (category && brand && category.brandRoots.includes(brand)) {
      return `${publicOrigin}/${category.slug}?${new URLSearchParams({ brands: brand })}`
    }
    const query = new URLSearchParams()
    if (category) query.set('danh-muc', category.slug)
    if (brand) query.set('thuong-hieu', brand)
    return '/danh-muc' + (query.size ? '?' + query : '')
  }
  return { categories, brands, types, categoriesFor, brandsFor, listing, all }
}

const fold = value => value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi').trim()

export function searchSample(products, q, limit) {
  const skuQuery = q.toLocaleLowerCase('vi')
  const nameQuery = fold(q)
  return products.flatMap(product => {
    const sku = product.sku.toLocaleLowerCase('vi')
    const name = fold(product.name)
    const rank = [sku === skuQuery, sku.startsWith(skuQuery), sku.includes(skuQuery),
      name.startsWith(nameQuery), name.includes(nameQuery)].indexOf(true)
    return rank < 0 ? [] : [{ product, rank }]
  }).sort((a, b) => a.rank - b.rank || a.product.name.localeCompare(b.product.name, 'vi') || a.product.id - b.product.id)
    .slice(0, limit).map(match => match.product)
}
