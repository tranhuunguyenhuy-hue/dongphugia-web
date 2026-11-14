import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductCard } from '@/components/ui/product-card'
import { StaticSubcategoryNavigation } from '@/components/category/static-subcategory-navigation'
import { SubcategoryIconGrid } from '@/components/category/subcategory-icon-grid'

vi.mock('next/link', () => ({ default: ({ href, prefetch, children, ...props }: { href: string; prefetch?: boolean; children: React.ReactNode }) =>
  <a {...props} href={href} data-speculative-read={prefetch === false ? 'disabled' : 'enabled'}>{children}</a> }))

describe('Public navigation read budget', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
  afterEach(() => vi.unstubAllGlobals())
  it('renders a full product grid without speculative PDP reads and preserves every destination', () => {
    const products = Array.from({ length: 48 }, (_, id) => ({
      id, name: `Product ${id}`, slug: `product-${id}`, url: `/thiet-bi-ve-sinh/bon-cau/product-${id}`,
      price: null, stock_status: 'contact', is_featured: false, is_promotion: false, variant_options: [],
    }))
    const { container } = render(<>{products.map(product => <ProductCard key={product.id} product={product} />)}</>)
    const links = [...container.querySelectorAll('a')]
    expect(links).toHaveLength(48)
    expect(links.every(link => link.dataset.speculativeRead === 'disabled')).toBe(true)
    expect(links.map(link => link.getAttribute('href'))).toEqual(products.map(product => product.url))
  })
  it('keeps static PLP navigation from starting background DB reads', () => {
    const categories = ['bon-cau','lavabo','bon-tam'].map((slug,id)=>({id,slug,name:slug,thumbnail_url:null}))
    const {container} = render(<StaticSubcategoryNavigation subcategories={categories} basePath="/thiet-bi-ve-sinh" />)
    expect([...container.querySelectorAll('a')].every(link=>link.dataset.speculativeRead==='disabled')).toBe(true)
  })
  it('keeps category carousel routes clickable without prefetching every PLP', () => {
    const categories = ['bon-cau', 'lavabo', 'bon-tam', 'bon-tieu'].map((slug, id) => ({
      id, slug, name: slug, thumbnail_url: null, _count: { products: 10 },
    }))
    const { container } = render(<SubcategoryIconGrid subcategories={categories} basePath="/thiet-bi-ve-sinh" />)
    const links = [...container.querySelectorAll('a')]
    expect(links.map(link => link.getAttribute('href'))).toEqual(categories.map(category => `/thiet-bi-ve-sinh/${category.slug}`))
    expect(links.every(link => link.dataset.speculativeRead === 'disabled')).toBe(true)
  })
})
