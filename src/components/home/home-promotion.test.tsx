import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const image = "/test-promotion.jpg"
const destination = "/uudaicuoinam2026/"

beforeEach(() => {
    vi.resetModules()
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete")
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
        configurable: true,
        value(this: HTMLDialogElement) {
            this.open = true
        },
    })
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
        configurable: true,
        value(this: HTMLDialogElement) {
            this.open = false
            fireEvent(this, new Event("close"))
        },
    })
})

afterEach(() => {
    cleanup()
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal")
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close")
    vi.restoreAllMocks()
})

describe("HomePromotion", () => {
    it.each(["", "#", "javascript:alert(1)", "//example.com", "/\\example.com", "https://"])(
        "disables the popup for invalid destination %j",
        async (invalidDestination) => {
            const { HomePromotion } = await import("./home-promotion")
            const { container } = render(<HomePromotion image={image} destination={invalidDestination} />)
            expect(container).toBeEmptyDOMElement()
        },
    )

    it("disables the popup without an image", async () => {
        const { HomePromotion } = await import("./home-promotion")
        const { container } = render(<HomePromotion image={null} destination={destination} />)
        expect(container).toBeEmptyDOMElement()
    })

    it("waits for the image, links the entire image, and closes separately", async () => {
        const { HomePromotion } = await import("./home-promotion")
        const { container } = render(<HomePromotion image={image} />)
        expect(screen.queryByRole("dialog")).toBeNull()

        fireEvent.load(container.querySelector("img")!)
        const dialog = screen.getByRole("dialog", { name: "Khuyến mãi TOTO cuối năm" })
        const link = within(dialog).getByRole("link")
        const close = within(dialog).getByRole("button", { name: "Đóng khuyến mãi" })
        expect(link).toHaveAttribute("href", destination)
        expect(link).toContainElement(within(dialog).getByRole("img"))
        expect(link).not.toContainElement(close)
        expect(document.documentElement.style.overflow).toBe("hidden")

        fireEvent.click(close)
        expect(screen.queryByRole("dialog")).toBeNull()
        expect(document.documentElement.style.overflow).toBe("")
    })

    it("shows again in a new document and suppresses remounts in the same document", async () => {
        const { HomePromotion } = await import("./home-promotion")
        const first = render(<HomePromotion image={image} />)
        fireEvent.load(first.container.querySelector("img")!)
        expect(screen.getByRole("dialog")).toBeInTheDocument()

        first.unmount()
        expect(document.documentElement.style.overflow).toBe("")
        expect(render(<HomePromotion image={image} />).container).toBeEmptyDOMElement()

        vi.resetModules()
        const { HomePromotion: ReloadedPromotion } = await import("./home-promotion")
        const reloaded = render(<ReloadedPromotion image={image} />)
        fireEvent.load(reloaded.container.querySelector("img")!)
        expect(screen.getByRole("dialog")).toBeInTheDocument()
    })
})
