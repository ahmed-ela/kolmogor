import AuthenticationServices
import SwiftUI
import WebKit

@main
struct KolmogorApp: App {
    var body: some Scene { WindowGroup { WorkspaceScreen() } }
}

struct WorkspaceScreen: View {
    @Environment(\.webAuthenticationSession) private var authentication
    @Environment(\.openURL) private var openURL
    @State private var web = WKWebView()
    @State private var signingIn = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            WorkspacePage(web: web, signIn: signIn, openProvider: { openURL($0) }, failed: { failure = $0 })
                .navigationTitle("Kolmogor")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    Button("Reload workspace", systemImage: "arrow.clockwise") { loadHome() }
                        .disabled(signingIn)
                }
                .alert("Workspace unavailable", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                    Button("Try again") { loadHome() }
                    Button("Cancel", role: .cancel) {}
                } message: { Text(failure ?? "") }
        }
    }

    private func loadHome() { web.load(URLRequest(url: WorkspaceSignIn.origin)) }

    private func signIn() {
        guard !signingIn else { return }
        signingIn = true
        Task { @MainActor in
            defer { signingIn = false }
            do {
                let attempt = try WorkspaceSignIn()
                let reply = try await authentication.authenticate(using: attempt.start, callback: .customScheme(WorkspaceSignIn.scheme), additionalHeaderFields: [:])
                web.load(try attempt.redeem(reply))
            } catch ASWebAuthenticationSessionError.canceledLogin {
                // The sign-in link stays available when the system sheet is dismissed.
            } catch {
                failure = "Google sign-in could not finish. Return to your workspace and try again."
            }
        }
    }
}

private struct WorkspacePage: UIViewRepresentable {
    let web: WKWebView
    let signIn: () -> Void
    let openProvider: (URL) -> Void
    let failed: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: WorkspaceSignIn.origin))
        return web
    }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.page = self }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var page: WorkspacePage
        init(_ page: WorkspacePage) { self.page = page }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url, url.scheme == "https", url.user == nil, url.password == nil,
                  url.port == nil else { return .cancel }
            let source = action.sourceFrame.securityOrigin
            let tapped = action.navigationType == .linkActivated && action.sourceFrame.isMainFrame
                && source.protocol == "https" && source.host == WorkspaceSignIn.origin.host && source.port == 0
            if url.host == WorkspaceSignIn.origin.host, action.targetFrame?.isMainFrame == true {
                if url.path == "/auth/google" {
                    if tapped { page.signIn() }
                    return .cancel
                }
                return .allow
            }
            let provider = ["auth.openai.com", "chatgpt.com", "claude.ai", "platform.claude.com", "console.anthropic.com"].contains(url.host)
                || (url.host == "accounts.google.com" && url.path == "/o/oauth2/auth")
            if tapped, provider { page.openProvider(url) }
            return .cancel
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                page.failed("The workspace returned an error (\(http.statusCode)). Please try again.")
                return .cancel
            }
            return .allow
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { page.failed("Check your internet connection and try again.") }
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            page.failed("The workspace page closed. Reload it to reconnect.")
        }
    }
}
