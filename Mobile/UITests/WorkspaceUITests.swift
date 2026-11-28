import XCTest

final class WorkspaceUITests: XCTestCase {
    @MainActor
    func testLivePilotOpensGoogleFromASignedOutPhone() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["KOLMOGOR_IOS_LIVE"] == "1",
                          "Requires a signed-out simulator and access to the pilot endpoint.")
        let app = XCUIApplication()
        app.launch()
        let signIn = app.webViews.links["Sign in with Google"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Reload workspace"].exists)
        signIn.tap()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let consent = system.alerts.buttons["Continue"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        let safari = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        let google = NSPredicate(format: "label CONTAINS[c] 'accounts.google.com' OR label CONTAINS[c] 'Email or phone' OR label CONTAINS[c] 'Use your Google Account'")
        let page = safari.descendants(matching: .any).matching(google).firstMatch
        let sheet = app.descendants(matching: .any).matching(google).firstMatch
        let reached = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in page.exists || sheet.exists }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [reached], timeout: 35), .completed)
    }
}
