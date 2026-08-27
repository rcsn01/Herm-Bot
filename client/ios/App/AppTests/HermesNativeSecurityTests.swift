import Foundation
import XCTest
@testable import HermesNativeSecurity

final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class HermesNativeSecurityTests: XCTestCase {
    private var cookieStorage: HTTPCookieStorage!
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        cookieStorage = HTTPCookieStorage.sharedCookieStorage(forGroupContainerIdentifier: UUID().uuidString)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = cookieStorage
        configuration.httpShouldSetCookies = true
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        session.invalidateAndCancel()
        super.tearDown()
    }

    func testRemoteURLValidatesWebSchemesAndPreservesProxyPrefix() throws {
        XCTAssertEqual(
            try HermesRemoteURLValidator.validate("https://agent.example/hermes///", allowLocalHTTP: false).absoluteString,
            "https://agent.example/hermes"
        )
        // HTTP is accepted for self-hosted gateways on encrypted overlays (e.g. Tailscale).
        XCTAssertEqual(
            try HermesRemoteURLValidator.validate("http://100.64.1.2:9119", allowLocalHTTP: false).absoluteString,
            "http://100.64.1.2:9119"
        )
        XCTAssertEqual(
            try HermesRemoteURLValidator.validate("http://localhost:8000", allowLocalHTTP: true).scheme,
            "http"
        )
        XCTAssertThrowsError(try HermesRemoteURLValidator.validate("ftp://agent.example", allowLocalHTTP: true))
    }

    func testExternalURLsAndTemporaryFilenamesAreRestricted() throws {
        XCTAssertEqual(try HermesExternalURLValidator.validate("https://example.com/report").host, "example.com")
        XCTAssertThrowsError(try HermesExternalURLValidator.validate("javascript:alert(1)"))
        XCTAssertThrowsError(try HermesExternalURLValidator.validate("https://user:secret@example.com"))
        XCTAssertEqual(HermesTemporaryFilePolicy.sanitizedFilename("../bad\r\nname.pdf"), ".._bad__name.pdf")
        XCTAssertEqual(HermesTemporaryFilePolicy.sanitizedFilename(".."), "download")
        XCTAssertLessThanOrEqual(HermesTemporaryFilePolicy.sanitizedFilename(String(repeating: "a", count: 300)).count, 180)
    }

    func testKeychainRoundTripAndDelete() throws {
        let vault = HermesKeychain(service: "com.nousresearch.hermes.mobile.tests.\(UUID().uuidString)")
        defer { vault.deleteToken() }
        XCTAssertNil(vault.readToken())
        try vault.saveToken("gateway-secret")
        XCTAssertEqual(vault.readToken(), "gateway-secret")
        vault.deleteToken()
        XCTAssertNil(vault.readToken())
    }

    func testRecognizesBareHostAndSecureCookieNames() {
        for prefix in ["", "__Host-", "__Secure-"] {
            XCTAssertEqual(HermesSessionCookiePolicy.baseName(of: "\(prefix)hermes_session_at"), "hermes_session_at")
            XCTAssertEqual(HermesSessionCookiePolicy.baseName(of: "\(prefix)hermes_session_rt"), "hermes_session_rt")
            XCTAssertEqual(HermesSessionCookiePolicy.baseName(of: "\(prefix)hermes_session_provider"), "hermes_session_provider")
        }
        XCTAssertNil(HermesSessionCookiePolicy.baseName(of: "idp_session"))
    }

    func testGatewayDomainPathAndSecureFiltering() throws {
        let gateway = URL(string: "https://agent.example/hermes")!
        let accepted = try cookie(name: "__Host-hermes_session_at", domain: "agent.example", path: "/", secure: true)
        let prefixed = try cookie(name: "hermes_session_rt", domain: ".agent.example", path: "/hermes/", secure: true)
        let wrongDomain = try cookie(name: "hermes_session_at", domain: "other.example", path: "/", secure: true)
        let wrongPath = try cookie(name: "hermes_session_at", domain: "agent.example", path: "/another", secure: true)
        let idp = try cookie(name: "idp_session", domain: "agent.example", path: "/", secure: true)

        XCTAssertEqual(
            Set(HermesSessionCookiePolicy.cookies([accepted, prefixed, wrongDomain, wrongPath, idp], for: gateway).map(\.name)),
            Set(["__Host-hermes_session_at", "hermes_session_rt"])
        )
        XCTAssertFalse(HermesSessionCookiePolicy.isGatewayCookie(accepted, for: URL(string: "http://localhost")!))
    }

    func testHttpOnlyCookieCanBeCopiedWithoutLosingAttributes() throws {
        let original = try cookie(name: "__Secure-hermes_session_at", domain: "agent.example", path: "/hermes", secure: true)
        cookieStorage.setCookie(original)
        let copied = try XCTUnwrap(cookieStorage.cookies?.first)
        XCTAssertTrue(copied.isHTTPOnly)
        XCTAssertTrue(copied.isSecure)
        XCTAssertEqual(copied.path, "/hermes")
        XCTAssertEqual(copied.expiresDate?.timeIntervalSince1970, original.expiresDate?.timeIntervalSince1970)
    }

    func testRefreshOnlySessionIsRetainedForNormalServerRotation() throws {
        let refresh = try cookie(name: "__Host-hermes_session_rt", domain: "agent.example", path: "/", secure: true)
        let selected = HermesSessionCookiePolicy.cookies([refresh], for: URL(string: "https://agent.example")!)
        XCTAssertFalse(HermesSessionCookiePolicy.hasAccessCookie(selected))
        XCTAssertTrue(HermesSessionCookiePolicy.hasRefreshCookie(selected))
    }

    func testURLSessionRotatesLatestHttpOnlyCookieAndMintsTicket() async throws {
        var requestIndex = 0
        MockURLProtocol.handler = { request in
            requestIndex += 1
            if request.url?.path == "/api/auth/ws-ticket" {
                return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"ticket":"fresh-ticket"}"#.utf8))
            }
            let value = requestIndex == 1 ? "old" : "rotated"
            return (
                HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil,
                    headerFields: ["Set-Cookie": "hermes_session_at=\(value); Path=/; Secure; HttpOnly"]
                )!, Data(#"{"user_id":"u"}"#.utf8)
            )
        }
        let me = URL(string: "https://agent.example/api/auth/me")!
        for _ in 0..<2 {
            let (_, response) = try await session.data(from: me)
            let http = try XCTUnwrap(response as? HTTPURLResponse)
            let headers = http.allHeaderFields.reduce(into: [String: String]()) {
                $0[String(describing: $1.key)] = String(describing: $1.value)
            }
            HTTPCookie.cookies(withResponseHeaderFields: headers, for: me).forEach(cookieStorage.setCookie)
        }
        let rotated = cookieStorage.cookies(for: me)?.first { $0.name == "hermes_session_at" }
        XCTAssertEqual(rotated?.value, "rotated")
        XCTAssertTrue(rotated?.isHTTPOnly == true)

        let (ticketData, ticketResponse) = try await session.data(from: URL(string: "https://agent.example/api/auth/ws-ticket")!)
        XCTAssertEqual((ticketResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: ticketData) as? [String: String])?["ticket"], "fresh-ticket")
    }

    func testTokenHeaderAndPasswordLoginContracts() async throws {
        var paths: [String] = []
        MockURLProtocol.handler = { request in
            paths.append(request.url!.path)
            if request.url?.path == "/api/status" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Hermes-Session-Token"), "secret")
            }
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data("{}".utf8))
        }
        var tokenRequest = URLRequest(url: URL(string: "https://agent.example/api/status")!)
        tokenRequest.setValue("secret", forHTTPHeaderField: "X-Hermes-Session-Token")
        _ = try await session.data(for: tokenRequest)
        var passwordRequest = URLRequest(url: URL(string: "https://agent.example/auth/password-login")!)
        passwordRequest.httpMethod = "POST"
        _ = try await session.data(for: passwordRequest)
        XCTAssertEqual(paths, ["/api/status", "/auth/password-login"])
    }

    func testLoginErrorsDescribeCancellationTimeoutAndVerificationFailure() {
        XCTAssertEqual(HermesNativeSecurityError.cancelled.errorDescription, "Sign in was cancelled.")
        XCTAssertTrue(HermesNativeSecurityError.timedOut.errorDescription?.contains("timed out") == true)
        XCTAssertTrue(HermesNativeSecurityError.loginVerificationFailed.errorDescription?.contains("verify") == true)
        XCTAssertTrue(HermesNativeSecurityError.embeddedBrowserUnavailable.errorDescription?.contains("password") == true)
    }

    private func cookie(
        name: String,
        domain: String,
        path: String,
        secure: Bool
    ) throws -> HTTPCookie {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: UUID().uuidString,
            .domain: domain,
            .path: path,
            .expires: Date(timeIntervalSinceNow: 3_600),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE"
        ]
        if secure { properties[.secure] = "TRUE" }
        return try XCTUnwrap(HTTPCookie(properties: properties))
    }
}
