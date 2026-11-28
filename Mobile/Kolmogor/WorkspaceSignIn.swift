import CryptoKit
import Foundation
import Security

struct WorkspaceSignIn {
    static let origin = URL(string: "https://accounts.kolmogor.com")!
    static let scheme = "kolmogor-account"
    private let verifier: String

    init() throws {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw URLError(.cannotCreateFile)
        }
        verifier = Self.encode(Data(bytes))
    }

    var start: URL {
        let challenge = Self.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
        return Self.origin.appending(path: "auth/google").appending(queryItems: [.init(name: "challenge", value: challenge)])
    }

    func redeem(_ callback: URL) throws -> URLRequest {
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parts.scheme == Self.scheme, parts.host == "complete", parts.path.isEmpty, parts.port == nil,
              parts.user == nil, parts.password == nil, parts.fragment == nil, parts.queryItems?.count == 1,
              let item = parts.queryItems?.first, item.name == "ticket", let ticket = item.value,
              ticket.utf8.count == 43, ticket.utf8.allSatisfy({ byte in
                  (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte) || byte == 45 || byte == 95
              }) else { throw URLError(.badServerResponse) }
        var request = URLRequest(url: Self.origin.appending(path: "auth/redeem"))
        request.httpMethod = "POST"
        request.setValue(Self.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("ticket=\(ticket)&verifier=\(verifier)".utf8)
        return request
    }

    private static func encode(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "=", with: "")
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    }
}
