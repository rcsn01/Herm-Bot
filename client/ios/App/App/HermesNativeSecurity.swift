import Foundation
import Security

enum HermesNativeSecurityError: LocalizedError, Equatable {
    case cancelled
    case embeddedBrowserUnavailable
    case invalidRemoteURL
    case loginVerificationFailed
    case missingSessionCookies
    case timedOut

    var errorDescription: String? {
        switch self {
        case .cancelled: return "Sign in was cancelled."
        case .embeddedBrowserUnavailable:
            return "This provider could not sign in inside Hermes Mobile. Use password or gateway-token authentication instead."
        case .invalidRemoteURL: return "Hermes Mobile requires a complete gateway URL starting with http:// or https://."
        case .loginVerificationFailed: return "Hermes could not verify the completed sign in."
        case .missingSessionCookies: return "Sign in completed without a Hermes gateway session."
        case .timedOut: return "Sign in timed out. Please try again."
        }
    }
}

final class HermesKeychain {
    private let service: String
    private let account = "session-token"

    init(service: String = "com.nousresearch.hermes.mobile.gateway") {
        self.service = service
    }

    func readToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func saveToken(_ token: String) throws {
        deleteToken()
        guard let data = token.data(using: .utf8) else { throw HermesNativeSecurityError.invalidRemoteURL }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data
        ]
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
            throw HermesNativeSecurityError.invalidRemoteURL
        }
    }

    func deleteToken() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ] as CFDictionary)
    }
}

enum HermesRemoteURLValidator {
    static func validate(_ raw: String, allowLocalHTTP: Bool) throws -> URL {
        guard var components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let host = components.host, !host.isEmpty else {
            throw HermesNativeSecurityError.invalidRemoteURL
        }
        // HTTP is accepted for any host: self-hosted gateways commonly ride an already-encrypted
        // overlay (for example Tailscale/WireGuard), where TLS adds no transport protection.
        guard components.scheme == "https" || components.scheme == "http" else {
            throw HermesNativeSecurityError.invalidRemoteURL
        }
        components.path = components.path.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let url = components.url else { throw HermesNativeSecurityError.invalidRemoteURL }
        return url
    }
}

enum HermesExternalURLValidator {
    static func validate(_ raw: String) throws -> URL {
        guard let components = URLComponents(string: raw),
              components.scheme == "http" || components.scheme == "https",
              components.user == nil, components.password == nil,
              let host = components.host, !host.isEmpty,
              let url = components.url else {
            throw HermesNativeSecurityError.invalidRemoteURL
        }
        return url
    }
}

enum HermesTemporaryFilePolicy {
    static func sanitizedFilename(_ filename: String) -> String {
        let name = filename
            .replacingOccurrences(of: "[\\r\\n\\\"/\\\\:]", with: "_", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty || name == "." || name == ".." ? "download" : String(name.prefix(180))
    }
}

enum HermesSessionCookiePolicy {
    static let baseNames = Set(["hermes_session_at", "hermes_session_rt", "hermes_session_provider"])

    static func baseName(of name: String) -> String? {
        let candidate: String
        if name.hasPrefix("__Host-") { candidate = String(name.dropFirst(7)) }
        else if name.hasPrefix("__Secure-") { candidate = String(name.dropFirst(9)) }
        else { candidate = name }
        return baseNames.contains(candidate) ? candidate : nil
    }

    static func isGatewayCookie(_ cookie: HTTPCookie, for gateway: URL) -> Bool {
        guard baseName(of: cookie.name) != nil,
              let gatewayHost = gateway.host?.lowercased() else { return false }
        let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard gatewayHost == domain || gatewayHost.hasSuffix(".\(domain)") else { return false }
        if cookie.isSecure && gateway.scheme != "https" { return false }

        let gatewayPath = gateway.path.isEmpty ? "/" : gateway.path
        let rawCookiePath = cookie.path.isEmpty ? "/" : cookie.path
        let cookiePath = rawCookiePath.count > 1
            ? rawCookiePath.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            : rawCookiePath
        return cookiePath == "/"
            || gatewayPath == cookiePath
            || gatewayPath.hasPrefix(cookiePath.hasSuffix("/") ? cookiePath : "\(cookiePath)/")
    }

    static func cookies(_ cookies: [HTTPCookie], for gateway: URL) -> [HTTPCookie] {
        cookies.filter { isGatewayCookie($0, for: gateway) }
    }

    static func hasAccessCookie(_ cookies: [HTTPCookie]) -> Bool {
        cookies.contains { baseName(of: $0.name) == "hermes_session_at" && !$0.value.isEmpty }
    }

    static func hasRefreshCookie(_ cookies: [HTTPCookie]) -> Bool {
        cookies.contains { baseName(of: $0.name) == "hermes_session_rt" && !$0.value.isEmpty }
    }
}
