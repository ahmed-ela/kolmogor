import CryptoKit
import XCTest
@testable import Kolmogor

final class WorkspaceSignInTests: XCTestCase {
    private let ticket = String(repeating: "A", count: 43)

    func testAttemptBindsSingleUseTicketToItsOwnVerifier() throws {
        let attempt = try WorkspaceSignIn()
        let other = try WorkspaceSignIn()
        XCTAssertNotEqual(attempt.start, other.start)
        XCTAssertEqual(attempt.start.host, "accounts.kolmogor.com")
        XCTAssertEqual(attempt.start.path, "/auth/google")
        let callback = try XCTUnwrap(URL(string: "kolmogor-account://complete?ticket=" + ticket))
        let request = try attempt.redeem(callback)
        XCTAssertEqual(request.url?.absoluteString, "https://accounts.kolmogor.com/auth/redeem")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), WorkspaceSignIn.origin.absoluteString)
        let body = try XCTUnwrap(String(data: XCTUnwrap(request.httpBody), encoding: .utf8))
        let fields = try XCTUnwrap(URLComponents(string: "?" + body)?.queryItems)
        XCTAssertEqual(fields.first(where: { $0.name == "ticket" })?.value, ticket)
        let verifier = try XCTUnwrap(fields.first(where: { $0.name == "verifier" })?.value)
        XCTAssertEqual(verifier.utf8.count, 43)
        let expected = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        XCTAssertEqual(URLComponents(url: attempt.start, resolvingAgainstBaseURL: false)?.queryItems, [.init(name: "challenge", value: expected)])
    }

    func testEmptyFragmentOnSystemBrowserReturnRedeemsTheSameTicket() throws {
        let attempt = try WorkspaceSignIn()
        let base = "kolmogor-account://complete?ticket=" + ticket
        let plain = try attempt.redeem(XCTUnwrap(URL(string: base)))
        let fromBrowser = try attempt.redeem(XCTUnwrap(URL(string: base + "#")))
        XCTAssertEqual(fromBrowser, plain)
        XCTAssertEqual(fromBrowser.httpBody, plain.httpBody)
    }

    func testRejectsWrongOrAmbiguousCallbacks() throws {
        let attempt = try WorkspaceSignIn()
        for raw in ["https://complete?ticket=" + ticket, "kolmogor-account://other?ticket=" + ticket,
                    "kolmogor-account://complete/unexpected?ticket=" + ticket, "kolmogor-account://complete?ticket=short",
                    "kolmogor-account://complete?ticket=" + ticket + "&ticket=" + ticket,
                    "kolmogor-account://complete?ticket=" + ticket + "#fragment",
                    "kolmogor-account://complete?ticket=" + ticket + "#%00", "kolmogor-account://complete#ticket=" + ticket,
                    "kolmogor-account://complete?ticket=short#", "kolmogor-account://user@complete?ticket=" + ticket] {
            XCTAssertThrowsError(try attempt.redeem(XCTUnwrap(URL(string: raw))))
        }
    }
}
