import { expect, test } from '@playwright/test'

const REQUIRED_PROJECTS = new Set(['mobile-390', 'desktop-1440'])
const PDP_PATH = '/thiet-bi-ve-sinh/bon-cau/stg-demo-bon-cau-smoke-test'

type FlightResponse = {
    path: string
    status: number
    contentType: string
    rscHeader: string | null
    routerPrefetch: string | null
}

test.describe('Public client navigation Flight acceptance', () => {
    test.describe.configure({ mode: 'serial' })

    test('keeps mobile and desktop route transitions on successful RSC responses', async ({ page }, testInfo) => {
        test.skip(
            !REQUIRED_PROJECTS.has(testInfo.project.name),
            'Navigation acceptance requires mobile and desktop browser projects.',
        )

        const flightResponses: FlightResponse[] = []
        const failedFlightResponses: FlightResponse[] = []
        page.on('response', (response) => {
            const url = new URL(response.url())
            if (url.origin !== 'http://localhost:3000' || !url.searchParams.has('_rsc')) return
            const requestHeaders = response.request().headers()
            const flight: FlightResponse = {
                path: url.pathname,
                status: response.status(),
                contentType: response.headers()['content-type'] ?? '',
                rscHeader: requestHeaders.rsc ?? null,
                routerPrefetch: requestHeaders['next-router-prefetch'] ?? null,
            }
            flightResponses.push(flight)
            if (flight.status !== 200 || !flight.contentType.includes('text/x-component')) {
                failedFlightResponses.push(flight)
            }
        })

        await page.goto('/', { waitUntil: 'domcontentloaded' })
        if ((page.viewportSize()?.width ?? 0) < 1024) {
            await page.getByRole('button', { name: 'Mở menu điều hướng' }).click()
            await page.getByRole('navigation', { name: 'Menu di động' })
                .getByRole('link', { name: 'Thiết bị vệ sinh' }).click()
        } else {
            await page.getByRole('button', { name: 'Xem sản phẩm' }).click()
            await page.getByRole('menu', { name: 'Danh mục sản phẩm' })
                .getByRole('menuitem', { name: 'Thiết bị vệ sinh' }).click()
        }
        await expect(page).toHaveURL(/\/thiet-bi-ve-sinh$/)
        await expect(page.locator('#main-content h1').first()).toContainText('Thiết Bị Vệ Sinh')

        await page.locator('#main-content a[href="/thiet-bi-ve-sinh/bon-cau"]').first().click()
        await expect(page).toHaveURL(/\/thiet-bi-ve-sinh\/bon-cau$/)
        await expect(page.locator('#main-content')).toContainText('Bồn cầu')

        await page.locator(`#main-content a[href="${PDP_PATH}"]`).first().click()
        await expect(page).toHaveURL(new RegExp(`${PDP_PATH.replaceAll('/', '\\/')}$`))
        await expect(page.locator('#main-content')).toContainText('STG-DEMO')

        await page.goBack()
        await expect(page).toHaveURL(/\/thiet-bi-ve-sinh\/bon-cau$/)
        await page.getByRole('link', { name: /Đông Phú Gia - Trang chủ/i }).first().click()
        await expect(page).toHaveURL('/')

        await page.locator('footer a[href="/blog"]').first().click()
        await expect(page).toHaveURL(/\/blog$/)
        await expect(page.locator('#main-content')).toBeVisible()

        await page.getByRole('button', { name: 'Mở tìm kiếm' }).first().click()
        await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).first().fill('STG-DEMO')
        await page.getByRole('textbox', { name: 'Tìm sản phẩm' }).first().press('Enter')
        await expect(page).toHaveURL(/\/tim-kiem\?q=STG-DEMO/)
        await expect(page.locator('#main-content')).toContainText('STG-DEMO')

        expect(failedFlightResponses).toEqual([])
        expect(flightResponses.length).toBeGreaterThanOrEqual(4)
        expect(flightResponses.every((response) => response.status === 200)).toBe(true)
        expect(flightResponses.every((response) => response.rscHeader === '1')).toBe(true)
    })
})
