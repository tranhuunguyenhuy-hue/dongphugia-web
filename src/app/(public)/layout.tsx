import { Header } from "@/components/layout/header-lazy"
import { Footer } from "@/components/layout/footer"
import { FloatingContact } from "@/components/layout/floating-contact"
import { PublicContent, PublicNavigationFeedback } from "@/components/layout/public-navigation-feedback"
import { commerceEnabled } from "@/lib/commerce/flags"

export default function PublicLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <PublicNavigationFeedback>
            <div className="flex min-h-screen flex-col">
                <a
                    href="#main-content"
                    className="fixed left-4 top-4 z-[100] -translate-y-24 rounded-md bg-brand-700 px-4 py-3 font-semibold text-white shadow-lg transition-transform focus:translate-y-0"
                >
                    Chuyển đến nội dung chính
                </a>
                <Header commerce={commerceEnabled()} />
                <PublicContent>{children}</PublicContent>
                <Footer />
                <FloatingContact />
            </div>
        </PublicNavigationFeedback>
    )
}
