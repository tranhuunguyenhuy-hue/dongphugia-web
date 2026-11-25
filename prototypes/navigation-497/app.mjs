import { canonicalProduct, makeCatalogue, publicOrigin, searchSample } from './catalogue.mjs'
import { categoryStyle, featuredBrands, featuredSeries, seriesLayoutSample, typeIcons } from './presentation.mjs'
import { icon } from './icons.mjs'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const safe = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char])
const offline = globalThis.navigationOffline
const entry = offline ? './' + location.pathname.split('/').at(-1) : ''
const localPath = path => {
  if (!offline || !path.startsWith('/')) return path
  const [view, query] = path.split('?')
  const params = new URLSearchParams(query)
  if (view !== '/') params.set('view', view)
  return entry + (params.size ? '?' + params : '')
}
const asset = name => offline?.assets[name] ?? '/assets/' + name
const snapshot = offline?.snapshot ?? await fetch('/snapshot.json').then(response => response.json())
const catalogue = makeCatalogue(snapshot)
const header = $('.site-header')
const mega = $('#mega')
const drawer = $('#drawer')
const drawerContent = $('.drawer-content')
const drawerTitle = $('#drawer-title')
const menuToggle = $('.menu-toggle')
const searchToggle = $('.search-toggle')
const search = $('#search')
const searchForm = $('form', search)
const input = $('input[type=search]', search)
const suggestions = $('#suggestions')
const triggers = $$('[data-mode]')
const seriesLayout = new URLSearchParams(location.search).get('layout') === 'series'
const desktop = matchMedia('(min-width: 1024px)')
const mouse = matchMedia('(any-hover: hover) and (any-pointer: fine)')
const titleCase = name => name.charAt(0).toLocaleUpperCase('vi') + name.slice(1)
const brandName = slug => catalogue.brands.find(brand => brand.slug === slug)?.name ?? ''
const categoryBySlug = slug => catalogue.categories.find(category => category.slug === slug)
const sectionLinks = $$('.secondary a').map(link => ({ label: link.textContent, href: link.href }))

let mode = null
let brand = ''
let category = catalogue.categories[0]
let pinned = false
let openTimer
let closeTimer
let mobileSearch = false
let drawerStack = []
let drawerOpener
let searchTimer
let searchRequest
let searchGeneration = 0
let restoringSearchFocus = false
const searchCache = new Map()

for (const element of $$('[data-icon]')) element.innerHTML = icon(element.dataset.icon)
if (offline) {
  for (const link of $$('a[href^="/"]')) link.setAttribute('href', localPath(link.getAttribute('href')))
}

function refreshCompact() {
  const heldOnMobile = !desktop.matches && (mobileSearch || search.contains(document.activeElement) || drawer.open)
  const heldOnDesktop = desktop.matches && document.activeElement?.closest('.top, .secondary')
  header.classList.toggle('compact', window.scrollY > 104 && !heldOnMobile && !heldOnDesktop)
}

function openMega(next, lock, focus) {
  if (!desktop.matches || drawer.open) return
  clearTimeout(closeTimer)
  if (mode !== next) {
    brand = ''
    category = catalogue.categories[0]
  }
  closeSearch()
  mode = next
  pinned = lock
  mega.hidden = false
  for (const button of triggers) button.setAttribute('aria-expanded', String(button.dataset.mode === mode))
  renderMega()
  if (focus) $('.rail button', mega)?.focus()
}

function closeMega(restore = false) {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  if (restore && mode) triggers.find(button => button.dataset.mode === mode)?.focus()
  mode = null
  pinned = false
  mega.hidden = true
  for (const button of triggers) button.setAttribute('aria-expanded', 'false')
}

function action(label, action, value = '', glyph = '', selected = null) {
  const pressed = selected === null ? '' : ` aria-pressed="${selected}"`
  return `<button type="button" data-action="${action}" data-value="${safe(value)}"${pressed}>${glyph ? icon(glyph) : ''}<span>${safe(label)}</span>${icon('next')}</button>`
}

function allLink(label, category, brand = '') {
  return `<a class="all-link" href="${safe(localPath(catalogue.all(category, brand)))}">${safe(label)} ${icon('arrow')}</a>`
}

function typeLinks(category, brand = '') {
  return catalogue.types(category, brand).map(type =>
    `<a class="type-link" href="${safe(catalogue.listing(category, type, brand))}">
      ${icon(typeIcons[type.slug])}<span>${safe(titleCase(type.name))}</span>${icon('arrow')}
    </a>`).join('')
}

function brandChoices(brands, selected, actionName) {
  const all = action('Tất cả', actionName, '', 'grid', selected === '')
  const allowed = featuredBrands.filter(slug => brands.some(brand => brand.slug === slug))
  const featured = allowed.map(slug => `<button type="button" class="brand-logo" data-action="${actionName}" data-value="${slug}" aria-pressed="${slug === selected}">
    <img src="${asset(slug + '.png')}" alt="" width="80" height="28" loading="lazy"><span>${safe(brandName(slug))}</span>
  </button>`).join('')
  const other = brands.filter(brand => !allowed.includes(brand.slug))
    .map(brand => action(brand.name, actionName, brand.slug, '', brand.slug === selected)).join('')
  return `${all}${featured ? `<div class="featured-brands">${featured}</div>` : ''}${other}`
}

function seriesPanel(category, brand) {
  const items = featuredSeries.filter(series => series.category === category.slug &&
    (!brand || series.brand === brand) && series.verifiedListing && series.image)
  if (!items.length) {
    if (!seriesLayout || category.slug !== seriesLayoutSample.category || (brand && brand !== seriesLayoutSample.brand)) return ''
    return `<aside class="series" aria-label="Minh họa bố cục dòng sản phẩm">
      <p class="eyebrow">Dòng sản phẩm nổi bật</p>
      <div class="series-placeholder">Chưa có ảnh được duyệt</div>
      <strong>${safe(seriesLayoutSample.name)}</strong>
      <p class="series-note">Minh họa bố cục · Chưa có Listing theo dòng</p>
    </aside>`
  }
  return `<aside class="series" aria-label="Dòng sản phẩm nổi bật">
    <p class="eyebrow">Dòng sản phẩm nổi bật</p>
    ${items.slice(0, 2).map(series => `<a href="${safe(series.verifiedListing)}">
      <img src="${safe(series.image)}" alt="" width="480" height="260" loading="lazy"><strong>${safe(series.name)}</strong>
    </a>`).join('')}
  </aside>`
}

function renderMega() {
  const productMode = mode === 'product'
  const focused = document.activeElement
  const focusData = mega.contains(focused) && focused.dataset.action
    ? { action: focused.dataset.action, value: focused.dataset.value } : null
  const positions = [$('.rail', mega)?.scrollTop, $('.panel', mega)?.scrollTop]
  const available = catalogue.categoriesFor(brand)
  const side = productMode
    ? catalogue.categories.map(item => action(item.name, 'category', item.slug, categoryStyle[item.slug].icon, item === category)).join('')
    : brandChoices(catalogue.brands, brand, 'ecosystem')
  const controls = productMode
    ? [{ slug: '', name: 'Tất cả' }, ...catalogue.brandsFor(category)].map(item =>
      `<button type="button" data-action="filter" data-value="${item.slug}" aria-pressed="${item.slug === brand}">${safe(item.name)}</button>`).join('')
    : available.map(item => `<button type="button" data-action="category" data-value="${item.slug}" aria-pressed="${item === category}">${safe(item.name)}</button>`).join('')
  const featured = seriesPanel(category, brand)
  mega.innerHTML = `<div class="wrap mega-grid ${featured ? 'with-series' : ''}">
    <div class="rail"><p class="eyebrow">${productMode ? 'Danh mục' : 'Thương hiệu'}</p>${side}</div>
    <div class="panel">
      <div class="panel-head"><div><p class="eyebrow">${productMode ? 'Mua sắm theo nhu cầu' : 'Mua sắm theo thương hiệu'}</p>
      <h2>${safe(productMode ? category.name : brandName(brand) || 'Tất cả thương hiệu')}</h2></div>
      ${allLink('Xem tất cả', category, brand)}</div>
      <div class="chips" role="group" aria-label="${productMode ? 'Lọc theo thương hiệu' : 'Chọn danh mục'}">${controls}</div>
      <div class="types">${typeLinks(category, brand)}</div>
      ${!productMode && brand ? allLink('Xem tất cả danh mục của ' + brandName(brand), null, brand) : ''}
    </div>
    ${featured}
  </div>`
  const rail = $('.rail', mega)
  const panel = $('.panel', mega)
  rail.scrollTop = positions[0] || 0
  panel.scrollTop = focusData?.action === 'ecosystem' ? 0 : positions[1] || 0
  const replacement = focusData && $$('[data-action]', mega).find(button =>
    button.dataset.action === focusData.action && button.dataset.value === focusData.value)
  if (replacement) replacement.focus({ preventScroll: true })
}

function scheduleClose() {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  if (!pinned) closeTimer = setTimeout(() => {
    if (!mega.contains(document.activeElement)) closeMega()
  }, 250)
}

for (const button of triggers) {
  button.addEventListener('pointerenter', event => {
    if (event.pointerType !== 'mouse' || !mouse.matches || pinned || search.contains(document.activeElement)) return
    clearTimeout(closeTimer)
    clearTimeout(openTimer)
    openTimer = setTimeout(() => openMega(button.dataset.mode, false, false), 300)
  })
  button.addEventListener('pointerleave', event => {
    if (event.pointerType === 'mouse') scheduleClose()
  })
  button.addEventListener('click', event => {
    clearTimeout(openTimer)
    if (mode === button.dataset.mode) closeMega()
    else openMega(button.dataset.mode, true, event.detail === 0)
  })
}
mega.addEventListener('pointerenter', () => clearTimeout(closeTimer))
mega.addEventListener('pointerleave', event => {
  if (event.pointerType === 'mouse') scheduleClose()
})
mega.addEventListener('click', event => {
  const button = event.target.closest('[data-action]')
  if (event.target.closest('a')) closeMega()
  if (!button) return
  const { action: kind, value } = button.dataset
  if (kind === 'category') {
    category = categoryBySlug(value)
    if (mode === 'product') brand = ''
  } else {
    brand = value
    if (kind === 'ecosystem') category = catalogue.categoriesFor(brand)[0]
  }
  pinned = true
  renderMega()
})

function renderDrawer() {
  const state = drawerStack.at(-1)
  const item = categoryBySlug(state.category)
  const pickedBrand = state.brand || ''
  let body
  let title
  if (state.step === 'root') {
    title = 'Menu'
    body = action('Sản phẩm', 'products', '', 'grid') + action('Thương hiệu', 'brands', '', 'tile') +
      `<div class="drawer-secondary">${sectionLinks.map(link =>
        `<a href="${safe(link.href)}">${safe(link.label)} ${icon('arrow')}</a>`).join('')}
        <a href="${publicOrigin}/lien-he">Liên hệ ${icon('arrow')}</a></div>`
  } else if (state.step === 'products' || state.step === 'brand-categories') {
    title = state.step === 'products' ? 'Sản phẩm' : brandName(pickedBrand) || 'Tất cả thương hiệu'
    body = catalogue.categoriesFor(pickedBrand).map(category =>
      action(category.name, 'types', category.slug, categoryStyle[category.slug].icon)).join('') +
      allLink('Xem tất cả', null, pickedBrand)
  } else if (state.step === 'brands' || state.step === 'filter-brand') {
    title = 'Thương hiệu'
    body = brandChoices(item ? catalogue.brandsFor(item) : catalogue.brands, pickedBrand, item ? 'apply-brand' : 'brand-categories')
  } else {
    title = item.name
    body = (state.productPath ? action(pickedBrand ? brandName(pickedBrand) : 'Thương hiệu · Tất cả', 'filter-brand', '', 'grid') : '') +
      `<div class="types">${typeLinks(item, pickedBrand)}</div>` +
      allLink('Xem tất cả', item, pickedBrand) + seriesPanel(item, pickedBrand)
  }
  drawerTitle.textContent = title
  drawerContent.innerHTML = body
  drawerContent.scrollTop = 0
  $('#drawer-back').hidden = drawerStack.length === 1
  drawerTitle.focus()
}

function openDrawer(step = 'root', selectedCategory, opener = menuToggle) {
  drawerOpener = opener
  closeMega()
  closeSearch()
  drawerStack = [{ step: 'root' }]
  if (step !== 'root') drawerStack.push({ step: 'products', productPath: true }, {
    step, category: selectedCategory, productPath: true,
  })
  if (!drawer.open) drawer.showModal()
  document.body.classList.add('locked')
  refreshCompact()
  renderDrawer()
}

menuToggle.addEventListener('click', () => openDrawer())
$('#drawer-close').addEventListener('click', () => drawer.close())
$('#drawer-back').addEventListener('click', () => {
  drawerStack.pop()
  renderDrawer()
})
drawer.addEventListener('close', () => {
  document.body.classList.remove('locked')
  if (!desktop.matches) drawerOpener?.focus({ preventScroll: true })
  refreshCompact()
})
drawer.addEventListener('click', event => {
  if (event.target === drawer) {
    const bounds = drawer.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) drawer.close()
  }
  if (event.target.closest('a')) drawer.close()
  const button = event.target.closest('[data-action]')
  if (!button) return
  const { action: step, value } = button.dataset
  const state = drawerStack.at(-1)
  if (step === 'apply-brand') {
    drawerStack.pop()
    drawerStack.at(-1).brand = value
  } else {
    const next = { step, brand: state.brand, category: state.category, productPath: state.productPath }
    if (step === 'products') next.productPath = true
    if (step === 'brand-categories') next.brand = value
    if (step === 'types') next.category = value
    drawerStack.push(next)
  }
  renderDrawer()
})

function closeSearch(restore = false) {
  clearTimeout(searchTimer)
  searchRequest?.abort()
  searchGeneration++
  suggestions.hidden = true
  mobileSearch = false
  searchToggle.setAttribute('aria-expanded', 'false')
  header.classList.remove('search-open')
  if (restore) {
    if (!desktop.matches && window.scrollY > 104) {
      if (search.contains(document.activeElement)) document.activeElement.blur()
      refreshCompact()
      searchToggle.focus()
    } else {
      restoringSearchFocus = true
      input.focus({ preventScroll: true })
      restoringSearchFocus = false
    }
  }
  refreshCompact()
}

searchToggle.setAttribute('aria-expanded', 'false')
searchToggle.addEventListener('click', () => {
  closeMega()
  mobileSearch = true
  searchToggle.setAttribute('aria-expanded', 'true')
  header.classList.add('search-open')
  refreshCompact()
  input.focus()
})

async function fetchResults(query, signal, limit = 8) {
  if (offline) {
    signal?.throwIfAborted()
    return { source: 'snapshot', results: searchSample(snapshot.products, query, limit) }
  }
  const response = await fetch('/api/search?' + new URLSearchParams({ q: query, limit }), { signal })
  if (!response.ok) throw new Error('Search unavailable')
  return response.json()
}

function resultLinks(results) {
  return results.filter(product => canonicalProduct.test(product.url)).map(product =>
    `<a class="result" href="${publicOrigin}${safe(product.url)}"><span><strong>${safe(product.name)}</strong><small>${safe(product.sku)}</small></span>${icon('arrow')}</a>`).join('')
}

function showSuggestions() {
  const query = input.value.trim()
  clearTimeout(searchTimer)
  searchRequest?.abort()
  const generation = ++searchGeneration
  if (query.length < 2) {
    suggestions.hidden = true
    return
  }

  suggestions.hidden = false
  const status = $('#search-status')
  const result = $('#search-results')
  const source = $('#search-source')
  status.textContent = 'Đang tìm sản phẩm…'
  result.replaceChildren()
  source.textContent = ''

  function display(data) {
    source.textContent = data.source === 'live' ? 'Catalogue public' : 'Mẫu catalogue local'
    status.textContent = data.results.length ? '' : 'Không tìm thấy sản phẩm. Thử tên hoặc mã SKU khác.'
    result.innerHTML = resultLinks(data.results)
  }

  if (searchCache.has(query)) {
    display(searchCache.get(query))
    return
  }
  searchTimer = setTimeout(async () => {
    searchRequest = new AbortController()
    try {
      const data = await fetchResults(query, searchRequest.signal)
      if (generation !== searchGeneration) return
      if (searchCache.size >= 20) searchCache.delete(searchCache.keys().next().value)
      searchCache.set(query, data)
      display(data)
    } catch (error) {
      if (generation !== searchGeneration || error.name === 'AbortError') return
      status.textContent = 'Tìm kiếm tạm thời gián đoạn. Hãy thử lại.'
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'retry'
      retry.textContent = 'Thử lại'
      retry.addEventListener('click', () => { input.focus(); showSuggestions() })
      result.append(retry)
    }
  }, 280)
}

input.addEventListener('focus', () => {
  closeMega()
  refreshCompact()
  if (!restoringSearchFocus) showSuggestions()
})
input.addEventListener('click', () => { if (suggestions.hidden) showSuggestions() })
input.addEventListener('input', showSuggestions)
search.addEventListener('focusout', event => {
  if (!search.contains(event.relatedTarget)) closeSearch()
})
search.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' && event.target === input) {
    const first = $('.result', suggestions)
    if (first && !suggestions.hidden) {
      event.preventDefault()
      first.focus()
    }
  }
})
searchForm.addEventListener('submit', event => {
  closeSearch()
  if (offline) {
    event.preventDefault()
    location.href = localPath('/tim-kiem?' + new URLSearchParams({ q: input.value.trim() }))
  }
})

document.addEventListener('pointerdown', event => {
  const target = event.target
  if (!mega.contains(target) && !triggers.some(button => button.contains(target))) closeMega()
  if (!search.contains(target) && !searchToggle.contains(target) && (mobileSearch || !suggestions.hidden)) {
    if (search.contains(document.activeElement)) document.activeElement.blur()
    closeSearch()
  }
})
document.addEventListener('focusin', event => {
  refreshCompact()
  if (mode && !mega.contains(event.target) && !triggers.includes(event.target)) closeMega()
})
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || drawer.open) return
  if (mode) closeMega(mega.contains(document.activeElement) || triggers.includes(document.activeElement))
  else if (mobileSearch || !suggestions.hidden) {
    event.preventDefault()
    closeSearch(true)
  }
})
desktop.addEventListener('change', () => {
  const focusWasInMega = mega.contains(document.activeElement) || triggers.includes(document.activeElement)
  closeMega()
  closeSearch()
  if (desktop.matches && drawer.open) {
    drawer.close()
    triggers[0].focus()
  }
  if (!desktop.matches && focusWasInMega) menuToggle.focus()
  refreshCompact()
})
window.addEventListener('scroll', refreshCompact, { passive: true })
window.addEventListener('pageshow', event => {
  if (event.persisted) { closeMega(); closeSearch(); if (drawer.open) drawer.close() }
  refreshCompact()
})

function browse(category, opener) {
  if (!desktop.matches) {
    openDrawer('types', category.slug, opener)
    return
  }
  openMega('product', true, false)
  const selection = $$('[data-action="category"]', mega).find(button => button.dataset.value === category.slug)
  selection?.focus()
  selection?.click()
}

function showHome(main) {
  main.innerHTML = `<section class="hero wrap" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="eyebrow"><span></span> Showroom Đông Phú Gia</p>
      <h1 id="hero-title">Chọn thiết bị cho<br> không gian của bạn</h1>
      <p>Tìm theo nhu cầu hoặc khám phá các thương hiệu thiết bị phòng tắm, nhà bếp, gạch ốp lát và vật liệu nước.</p>
      <button type="button" class="cta" data-browse="thiet-bi-ve-sinh">Khám phá sản phẩm ${icon('arrow')}</button>
    </div>
    <div class="hero-image"><img src="${asset('interior.jpg')}" width="640" height="640" alt="Phòng tắm ốp đá tông ấm tại không gian minh họa"></div>
  </section>
  <section class="collections wrap" aria-labelledby="collections-title">
    <div class="section-title"><h2 id="collections-title">Danh mục sản phẩm</h2><a class="all-link" href="${localPath('/danh-muc')}">Xem tất cả ${icon('arrow')}</a></div>
    <div class="collection-grid">${catalogue.categories.map(({ slug, name }) => `<button type="button" data-browse="${slug}">
      ${icon(categoryStyle[slug].icon)}<span><strong>${safe(name)}</strong><small>${safe(categoryStyle[slug].description)}</small></span>${icon('arrow')}
    </button>`).join('')}</div>
    <div class="showroom"><div><h2>Ghé showroom tại Đà Lạt</h2><p>273–275 Phan Đình Phùng · 0913 865 685</p></div>
    <a class="all-link" href="${publicOrigin}/lien-he">Thông tin liên hệ ${icon('arrow')}</a></div>
  </section>`
  for (const button of $$('[data-browse]', main)) {
    button.addEventListener('click', () => browse(categoryBySlug(button.dataset.browse), button))
  }
}

function showCollection(main) {
  const params = new URLSearchParams(location.search)
  const pickedBrand = brandName(params.get('thuong-hieu')) ? params.get('thuong-hieu') : ''
  const pickedCategory = categoryBySlug(params.get('danh-muc'))
  const categories = catalogue.categoriesFor(pickedBrand).filter(item => !pickedCategory || pickedCategory === item)
  view(main, pickedCategory?.name ?? (brandName(pickedBrand) || 'Tất cả danh mục'),
    'Danh sách rút gọn từ catalogue công khai để duyệt điều hướng.', categories.map(category =>
      `<section class="collection-section"><h2>${safe(category.name)}</h2><div class="types">${typeLinks(category, pickedBrand)}</div></section>`).join('') ||
      '<p>Chưa có loại sản phẩm đã xác minh cho lựa chọn này.</p>')
}

function view(main, title, description, body) {
  main.innerHTML = `<div class="wrap destination">
    <a class="all-link" href="${localPath('/')}">${icon('back')} Về prototype</a>
    <h1>${safe(title)}</h1><p>${safe(description)}</p>${body}
  </div>`
}

const demoCartKey = 'dpg-nav-497-demo-cart'
const readDemoCart = () => sessionStorage.getItem(demoCartKey) === 'sample' ? 2 : 0
function updateCart() {
  const count = readDemoCart()
  const cart = $('.cart')
  cart.innerHTML = icon('bag') + (count ? `<span class="cart-count">${count}</span>` : '')
  cart.setAttribute('aria-label', count ? `Giỏ hàng (${count} sản phẩm)` : 'Giỏ hàng')
}

function showCart(main) {
  const count = readDemoCart()
  const example = snapshot.products.find(product => product.sku === 'MS636DT2#XW') ?? snapshot.products[0]
  view(main, 'Giỏ hàng', 'Giỏ mô phỏng local. Số lượng được tính theo tổng đơn vị sản phẩm.',
    `${count ? `<div class="result"><span><strong>${safe(example.name)}</strong><small>${safe(example.sku)} · Số lượng ${count}</small></span></div>`
      : '<p>Giỏ hàng đang trống.</p>'}
    <button type="button" id="demo-cart" class="cta">${count ? 'Xóa dữ liệu thử' : 'Thử với 2 sản phẩm'}</button>`)
  $('#demo-cart').addEventListener('click', () => {
    if (count) sessionStorage.removeItem(demoCartKey)
    else sessionStorage.setItem(demoCartKey, 'sample')
    updateCart()
    showCart(main)
    $('#demo-cart').focus()
  })
}

async function showSearchPage(main) {
  const query = (new URLSearchParams(location.search).get('q') ?? '').slice(0, 120).trim()
  const label = query ? `Kết quả cho “${query}”` : 'Tìm sản phẩm'
  input.value = query
  view(main, label, '', '<div id="submitted-results" role="status">Đang tìm sản phẩm…</div>')
  const results = $('#submitted-results')
  if (query.length < 2) {
    results.textContent = 'Nhập ít nhất 2 ký tự để tìm kiếm.'
    return
  }
  try {
    const data = await fetchResults(query, undefined, 24)
    results.innerHTML = `<p>${data.source === 'live' ? 'Catalogue public' : 'Mẫu catalogue local'}</p>${
      resultLinks(data.results) || '<p>Không tìm thấy sản phẩm.</p>'}`
  } catch {
    results.innerHTML = '<p>Tìm kiếm tạm thời gián đoạn.</p>'
    const retry = document.createElement('button')
    retry.className = 'retry'
    retry.textContent = 'Thử lại'
    retry.addEventListener('click', () => showSearchPage(main))
    results.append(retry)
  }
}

const main = $('#content')
updateCart()
const route = offline ? new URLSearchParams(location.search).get('view') : location.pathname
if (route === '/danh-muc') showCollection(main)
else if (route === '/gio-hang') showCart(main)
else if (route === '/tim-kiem') await showSearchPage(main)
else showHome(main)
$('footer').hidden = false
refreshCompact()
