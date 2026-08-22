import Foundation
import UIKit
import WebKit

final class HermesLoginViewController: UIViewController, WKNavigationDelegate, WKHTTPCookieStoreObserver {
    typealias Completion = (Result<[String: Any], Error>) -> Void

    private let gateway: URL
    private let provider: String
    private let session: URLSession
    private let completion: Completion
    private let cookieStore = WKWebsiteDataStore.default().httpCookieStore
    private var completed = false
    private var verificationInFlight = false
    private var timeoutTimer: Timer?
    private lazy var webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.translatesAutoresizingMaskIntoConstraints = false
        return view
    }()

    init(gateway: URL, provider: String, session: URLSession, completion: @escaping Completion) {
        self.gateway = gateway
        self.provider = provider
        self.session = session
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Sign in to Hermes"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel,
            target: self,
            action: #selector(cancel)
        )
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        cookieStore.add(self)
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in
            self?.finish(.failure(HermesNativeSecurityError.timedOut))
        }
        guard let loginURL = loginURL() else {
            return finish(.failure(HermesNativeSecurityError.invalidRemoteURL))
        }
        webView.load(URLRequest(url: loginURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    deinit {
        timeoutTimer?.invalidate()
        cookieStore.remove(self)
    }

    @objc private func cancel() {
        finish(.failure(HermesNativeSecurityError.cancelled))
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        inspectCookies()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inspectCookies(failIfMissing: isGatewayLandingPage(webView.url))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failNavigation(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failNavigation(error)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            decisionHandler(.cancel)
            finish(.failure(HermesNativeSecurityError.embeddedBrowserUnavailable))
        } else {
            decisionHandler(.allow)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.failure(HermesNativeSecurityError.embeddedBrowserUnavailable))
    }

    private func failNavigation(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        finish(.failure(HermesNativeSecurityError.embeddedBrowserUnavailable))
    }

    private func inspectCookies(failIfMissing: Bool = false) {
        guard !completed, !verificationInFlight else { return }
        cookieStore.getAllCookies { [weak self] allCookies in
            guard let self, !self.completed else { return }
            let cookies = HermesSessionCookiePolicy.cookies(allCookies, for: self.gateway)
            guard HermesSessionCookiePolicy.hasAccessCookie(cookies) else {
                if failIfMissing { self.finish(.failure(HermesNativeSecurityError.missingSessionCookies)) }
                return
            }
            self.verificationInFlight = true
            cookies.forEach { HTTPCookieStorage.shared.setCookie($0) }
            self.verifyLogin()
        }
    }

    private func isGatewayLandingPage(_ url: URL?) -> Bool {
        guard let url, url.host?.lowercased() == gateway.host?.lowercased() else { return false }
        let actual = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let expected = gateway.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return actual == expected && url.query == nil
    }

    private func verifyLogin() {
        guard let url = routeURL("/api/auth/me") else {
            verificationInFlight = false
            return finish(.failure(HermesNativeSecurityError.invalidRemoteURL))
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = true
        session.dataTask(with: request) { [weak self] data, response, _ in
            guard let self, !self.completed else { return }
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  let data,
                  let identity = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                self.verificationInFlight = false
                return self.finish(.failure(HermesNativeSecurityError.loginVerificationFailed))
            }
            self.finish(.success(identity))
        }.resume()
    }

    private func loginURL() -> URL? {
        guard let route = routeURL("/auth/login"),
              var components = URLComponents(url: route, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = [URLQueryItem(name: "provider", value: provider)]
        return components.url
    }

    private func routeURL(_ path: String) -> URL? {
        let base = gateway.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: base + (path.hasPrefix("/") ? path : "/\(path)"))
    }

    private func finish(_ result: Result<[String: Any], Error>) {
        DispatchQueue.main.async {
            guard !self.completed else { return }
            self.completed = true
            self.timeoutTimer?.invalidate()
            self.cookieStore.remove(self)
            self.webView.stopLoading()
            self.completion(result)
        }
    }
}
