import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  postgres: true,
  getLiveCategory: vi.fn(),
  getLiveCategories: vi.fn(),
}))

vi.mock('./public-db', () => ({ publicPostgresEnabled: () => mocks.postgres }))
vi.mock('./live-public-catalogue', () => ({
  getLiveCategory: mocks.getLiveCategory,
  getLiveCategories: mocks.getLiveCategories,
  getLiveListing: vi.fn(),
  getLiveProduct: vi.fn(),
  getLiveVariantSiblings: vi.fn(),
}))
vi.mock('./public-snapshot-mode', () => ({
  usesPublicSnapshot: () => true,
  usesProductionPublishedCatalogue: () => false,
  publicSnapshotCheckpoint: () => null,
}))

import { getSnapshotCategoryRoot } from './public-snapshot-catalogue'

describe('PostgreSQL category root routing', () => {
  beforeEach(() => {
    mocks.postgres = true
    mocks.getLiveCategory.mockReset().mockResolvedValue({
      slug: 'thiet-bi-bep',
      name: 'Thiết bị bếp',
      listings: [{ slug: 'voi-rua-chen', name: 'Vòi rửa chén', totalCount: 12 }],
      homeProducts: [],
      totalCount: 12,
      brands: [{ slug: 'acme', name: 'Acme' }],
      featuredProducts: [],
    })
    mocks.getLiveCategories.mockReset()
  })

  it('loads only the requested category for a category-root navigation', async () => {
    const root = await getSnapshotCategoryRoot('thiet-bi-bep')

    expect(root).toMatchObject({
      categoryName: 'Thiết bị bếp',
      basePath: '/thiet-bi-bep',
      subcategories: [{ slug: 'voi-rua-chen', _count: { products: 12 } }],
      brands: [{ id: 'acme', name: 'Acme', slug: 'acme' }],
    })
    expect(mocks.getLiveCategory).toHaveBeenCalledWith('thiet-bi-bep')
    expect(mocks.getLiveCategory).toHaveBeenCalledOnce()
    expect(mocks.getLiveCategories).not.toHaveBeenCalled()
  })
})
