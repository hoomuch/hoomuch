# hoomuch — Ürün ve Teknik Spesifikasyon (v1)

> Durum: **v1 uygulandı, entegrasyon doğrulamasında** · Tarih: 2026-11-05 · Sahibi: Lead (ana session)
>
> Bu doküman tek doğruluk kaynağıdır. Kod ile çelişirse spec kazanır; spec yanlışsa önce spec güncellenir.

---

## 1. Özet

Indie geliştiriciler gelirlerini birden fazla platformdan alır: web ürünü Stripe veya Lemon Squeezy ile,
mobil uygulama RevenueCat ile satılır. Her platformun paneli, para birimi ve metrik tanımı farklıdır;
"bu ay toplam ne kazanıyorum?" sorusunun cevabı bir hesap tablosunda kaybolur.

**hoomuch** bu hesapları **salt-okunur API anahtarlarıyla** bağlar, verileri düzenli olarak çeker ve
tek ekranda gösterir: toplam MRR, ARR, aktif abonelik, aktif deneme, dönem geliri ve sağlayıcı kırılımı.

Tasarım ilkesi: **indie minimalizm** — tek bakışta cevap, az renk, sıfıra yakın JavaScript, hızlı.

---

## 2. Hedef kullanıcı ve senaryolar

**Persona:** 1–3 ürünü olan indie hacker / küçük ekip. Ürünlerini farklı platformlarda satıyor.

| # | Senaryo | Başarı ölçütü |
|---|---------|---------------|
| S1 | "Bu ay toplam ne kadar kazanıyorum?" | Girişten sonra dashboard'da toplam MRR ilk bakışta görünür |
| S2 | Yeni bir hesap bağlamak | Anahtar yapıştırıp kaydetmek < 1 dakika, hata olursa sebebi net |
| S3 | Hangi platform/ürün büyüyor? | Sağlayıcı kırılımı + MRR trendi + dönemsel değişim yüzdesi |
| S4 | Son ödemeler ve iadeler | Birleşik işlem listesi, sağlayıcıya göre filtre |
| S5 | Kendi Cloudflare hesabında self-host | `wrangler deploy` + 1 secret; `ALLOW_SIGNUP=false` ile tek kullanıcı |
| S6 | Anahtar vermeden denemek | "Demo bağlantısı" ile örnek veriyle dolu dashboard |

---

## 3. İhtiyaçlar listesi

### 3.1 Fonksiyonel ihtiyaçlar

| ID | İhtiyaç | Öncelik |
|----|---------|---------|
| F-01 | E-posta + parola ile kayıt, giriş, çıkış. `ALLOW_SIGNUP=false` iken kayıt kapalı | P0 |
| F-02 | Bağlantı ekleme: **Stripe** (restricted key), **Lemon Squeezy** (API key, opsiyonel Store ID), **RevenueCat** (v2 secret key + Project ID) | P0 |
| F-03 | Kaydetmeden önce anahtarı canlı doğrulama; anlaşılır hata mesajı (yetki eksik, geçersiz anahtar, vb.) | P0 |
| F-04 | Bağlantıları listeleme, yeniden adlandırma, anahtar yenileme, silme (onaylı) | P0 |
| F-05 | **Demo bağlantısı**: anahtarsız, deterministik örnek veri (çoklu para birimi, 90 gün geçmiş) | P0 |
| F-06 | Otomatik senkronizasyon (Cron) + elle "Sync now" | P0 |
| F-07 | İlk bağlantıda 90 gün geriye dönük gelir verisi (backfill) | P0 |
| F-08 | Dashboard KPI'ları: MRR, ARR, aktif abonelik, aktif deneme, dönem geliri; önceki döneme göre değişim | P0 |
| F-09 | Bağlantı bazında kırılım tablosu (MRR payı %) | P0 |
| F-10 | Günlük gelir grafiği (bağlantı bazında yığılmış çubuk) ve MRR trend grafiği | P0 |
| F-11 | Dönem seçici: 7 / 30 / 90 gün | P0 |
| F-12 | Görüntüleme para birimi (varsayılan USD; EUR, GBP, TRY, …) ve günlük döviz kuru | P0 |
| F-13 | Bağlantı durumu: son senkronizasyon zamanı, son hata, son çalıştırmalar | P0 |
| F-14 | Birleşik işlem listesi (ödeme/iade), sağlayıcı filtresi, sayfalama | P1 |
| F-15 | Ayarlar: para birimi, parola değiştirme, hesabı tüm verisiyle silme | P1 |
| F-16 | Günlük gelir CSV dışa aktarma | P2 |
| F-17 | Webhook ile gerçek zamanlı güncelleme | v1.1 |

### 3.2 Fonksiyonel olmayan ihtiyaçlar

| ID | İhtiyaç |
|----|---------|
| N-01 | **Altyapı:** Tek Cloudflare Worker (Hono) + Workers Static Assets + D1 + Cron Triggers. Wrangler ile geliştirme/dağıtım. Harici veritabanı yok. |
| N-02 | **Performans:** Sunucu tarafı render (SSR) HTML; istemci JS ≈ 0; dashboard yalnızca D1'den okur (sağlayıcıya canlı çağrı yapmaz). |
| N-03 | **Güvenlik:** API anahtarları AES-256-GCM ile şifreli; parolalar PBKDF2-SHA256 (100.000 iterasyon); HttpOnly oturum çerezi; CSRF koruması; sıkı CSP; giriş deneme sınırı; gizli bilgi asla loglanmaz. |
| N-04 | **Gizlilik:** Son müşterilerin e-posta/isim gibi kişisel verileri **saklanmaz**. Yalnızca tutar, para birimi, zaman, harici ID, ürün/plan adı. |
| N-05 | **Dayanıklılık:** Bir sağlayıcının hatası diğerlerini etkilemez; 429/5xx'te üstel geri çekilme; idempotent upsert; sayfalı çekim ve cursor ile kaldığı yerden devam. |
| N-06 | **Doğruluk:** Tüm tutarlar **minor unit tamsayı** (kuruş/cent); para birimi ISO 4217 büyük harf; ondalıksız para birimleri (JPY, KRW…) doğru. |
| N-07 | **Erişilebilirlik:** Semantik HTML, WCAG AA kontrast, klavye ile gezinme, grafikler için veri tablosu alternatifi. |
| N-08 | **Test edilebilirlik:** Sağlayıcı adaptörleri enjekte edilen `fetch` ile saf; fixture tabanlı Vitest birim testleri. |
| N-09 | **Self-host:** `wrangler deploy` + tek secret (`ENCRYPTION_KEY`) ile ayağa kalkar. |
| N-10 | **Gözlemlenebilirlik:** Workers Observability açık; her senkronizasyon `sync_runs` tablosuna yazılır. |

### 3.3 Kapsam dışı (v1)

Takım/organizasyon hesapları · App Store Connect / Google Play doğrudan entegrasyonu · Paddle, Polar,
Gumroad (adaptör arayüzü bunlara hazır) · kohort/LTV analizi · e-posta raporları · webhook'lar ·
OAuth (Stripe Connect) ile bağlama · tarihsel döviz kuru ile geriye dönük çevrim.

---

## 4. Mimari

```
Tarayıcı ──HTTPS──▶ Cloudflare Worker  (tek deploy)
                    ├─ Static Assets ─ /app.css, /favicon.svg   (Worker'ı çağırmadan servis edilir)
                    ├─ Hono router + hono/jsx SSR sayfaları
                    ├─ D1 (SQLite) ─ users, sessions, connections, snapshots,
                    │                transactions, daily_revenue, fx_rates, sync_runs
                    └─ scheduled()  ──▶ sync engine ──▶ Stripe API
                                                   ├──▶ Lemon Squeezy API
                                                   ├──▶ RevenueCat API v2
                                                   └──▶ frankfurter.dev (ECB kurları)
```

| Katman | Seçim |
|--------|-------|
| Runtime | Cloudflare Workers (`compatibility_date` 2026-11-01) |
| Router / SSR | Hono 4 + `hono/jsx` |
| Stil | Tailwind CSS 4 + daisyUI 5, Tailwind CLI ile `public/app.css`'e derlenir (Wrangler `build` adımı) |
| Veritabanı | Cloudflare D1, `migrations/` |
| Zamanlama | Cron Triggers `*/30 * * * *` |
| Test | Vitest (Node ortamı; adaptörler ve saf fonksiyonlar) |
| Dil | TypeScript (strict) |

### 4.1 Akışlar

**Bağlantı ekleme:** form → `parseInput` (alan doğrulama) → `adapter.verify` (canlı API çağrısı) →
kimlik bilgisi şifrelenir → D1 → `waitUntil(syncConnection(..., 'initial'))` → `/connections/:id`.

**Senkronizasyon (bir bağlantı):**
1. `status='syncing'`, `sync_runs` kaydı aç.
2. `fetchSnapshot` → bugünün `snapshots` satırını upsert et.
3. `fetchRevenue` → `revenue_cursor` varsa oradan, yoksa `revenue_synced_until − 2 gün` (ilk sefer: şimdi − 90 gün).
   Dönen `events` → `transactions` upsert; etkilenen günler için `daily_revenue` yeniden hesaplanır.
   Dönen `daily` (RevenueCat gibi) → doğrudan `daily_revenue` upsert (`source='provider'`).
4. Sayfa bütçesi dolduysa `revenue_cursor` saklanır (sonraki çalışmada devam); bittiyse cursor temizlenir,
   `revenue_synced_until` ilerletilir.
5. `status='ok'|'error'`, `last_error`, `last_synced_at`, `sync_runs` kapanır.

**Cron:** Her 30 dakikada bir; `last_synced_at` en eski olan ve `SYNC_INTERVAL_MINUTES`'tan eski
**en fazla 10 bağlantı** sırayla senkronize edilir. Her bağlantı için sayfa bütçesi 20 istek.
Günde bir kez FX kurları yenilenir.

**Elle senkronizasyon:** Aynı bağlantı için 60 saniyede bir. İstek içinde çalışır, sonuç flash mesajla döner.

**Dashboard:** Yalnızca D1'den okur → tipik yanıt < 150 ms.

### 4.2 Limitler ve ölçeklenme

- PBKDF2 100k iterasyon ve senkronizasyon, Free plan'ın 10 ms CPU limitini aşabilir → **Workers Paid önerilir**.
- v1.1 ölçeklenme yolu: Cron → Cloudflare Queues fan-out (bağlantı başına mesaj) + sağlayıcı webhook'ları.

---

## 5. Veri modeli (D1)

Kaynak: [`migrations/0001_init.sql`](migrations/0001_init.sql). Özet:

| Tablo | Anahtar | Amaç |
|-------|---------|------|
| `users` | `id` | e-posta (NOCASE, unique), parola hash'i, `base_currency` |
| `sessions` | `id` = sha256(token) | oturumlar; token'ın kendisi saklanmaz |
| `login_attempts` | `key` = sha256(email\|ip) | giriş deneme sınırı |
| `connections` | `id` (UUID) | sağlayıcı, ad, **şifreli** kimlik bilgisi, `config` (JSON), durum, cursor |
| `snapshots` | (`connection_id`, `day`) | günlük metrik anlık görüntüsü; MRR **MoneyMap JSON** (`{"USD":12300,"EUR":4500}`) |
| `transactions` | (`connection_id`, `external_id`) | ödeme/iade olayları (PII yok) |
| `daily_revenue` | (`connection_id`, `day`, `currency`) | birleşik günlük gelir; dashboard grafiği buradan okur |
| `fx_rates` | `day` | USD bazlı günlük kurlar (JSON) |
| `sync_runs` | `id` | senkronizasyon geçmişi |

**MoneyMap:** Bir sağlayıcı birden fazla para biriminde satış yapabilir. MRR ve dönem geliri
`{ [ISO kodu]: minor unit }` olarak saklanır; görüntüleme anında kullanıcının para birimine çevrilir.

---

## 6. Metrik tanımları

Tüm tutarlar minor unit tamsayıdır. Görüntülemede `Intl.NumberFormat` kullanılır.

| Metrik | Tanım |
|--------|-------|
| **MRR** | Aktif (ücretli) aboneliklerin aylığa normalize edilmiş tekrarlayan tutarı. Deneme süresindekiler **dahil değil**. Dönem sonunda iptal edilecek ama hâlâ aktif olanlar **dahil**. |
| **ARR** | MRR × 12 |
| **Aktif abonelik** | Ücretli aktif abonelik sayısı (past_due dahil, deneme hariç) |
| **Aktif deneme** | Deneme süresindeki abonelik sayısı |
| **Dönem geliri** | Seçili pencerede `daily_revenue` toplamı: brüt tahsilat − iadeler. Sağlayıcı komisyonları **düşülmez** (v1). |
| **Değişim %** | MRR/abonelik/deneme: pencerenin başındaki en yakın snapshot'a göre. Gelir: bir önceki eşit uzunluktaki pencereye göre. Veri yoksa `null` (UI'da "—"). |

**Aylığa normalize:** `day → ×365/12`, `week → ×52/12`, `month → ×1`, `year → ×1/12`; hepsi `interval_count`'a bölünür.
Sonuç en yakın tamsayıya yuvarlanır.

**Döviz:** frankfurter.dev (ECB) günlük kurlar, USD baz, günde bir çekilir. Çevrim görüntüleme anında güncel kurla yapılır.
Desteklenmeyen para birimi toplamdan hariç tutulur ve dashboard'da uyarı gösterilir.

### 6.1 Stripe

- **Kimlik:** Restricted key (`rk_live_…`) önerilir; `sk_…` kabul edilir ama uyarı gösterilir. `*_test_*` anahtarlar test modu olarak etiketlenir.
- **Sürüm:** `Stripe-Version: 2026-10-28.endive` sabitlenir.
- **Gerekli izinler (read):** Subscriptions, Prices, Coupons, Balance (balance transactions). Coupons izni yoksa
  MRR indirimsiz hesaplanır ve uyarı gösterilir.
- **Doğrulama:** `GET /v1/subscriptions?limit=1` ve `GET /v1/balance_transactions?limit=1`.
- **MRR:** `GET /v1/subscriptions?status=active` ve `status=past_due` (sayfalı, `limit=100`, `expand[]=data.discounts`).
  Her item: `price.recurring.{interval, interval_count}`, `price.unit_amount` (yoksa `unit_amount_decimal`), `quantity`.
  `usage_type=metered` olanlar hariç, kademeli (tiered) fiyatlar 0 sayılır. Bu API sürümünde indirim yalnızca kupon ID'si
  taşır; kupon `GET /v1/coupons/{id}` ile çekilip (çalışma başına önbellek) `percent_off`/`amount_off` uygulanır.
  Para birimi: `subscription.currency`. Sayfa bütçesiyle ~7.000 aktif aboneliğe kadar okunur.
- **Deneme:** `status=trialing` sayısı.
- **Gelir:** `GET /v1/balance_transactions?created[gte]=…` — `charge`/`payment` → charge (brüt `amount`, `fee`);
  `refund`/`payment_refund` → refund (negatif). Para birimi: bakiye (settlement) para birimi.

### 6.2 Lemon Squeezy

- **Taban:** `https://api.lemonsqueezy.com/v1`, JSON:API (`Accept: application/vnd.api+json`), `Authorization: Bearer`.
- **Kimlik:** API key (tam yetkili — UI'da uyarı gösterilir). Opsiyonel Store ID; boşsa anahtarın erişebildiği tüm mağazalar.
- **Doğrulama:** `GET /v1/users/me` + `GET /v1/stores` (mağaza para birimleri `config`'e yazılır).
- **MRR:** `GET /v1/subscriptions?filter[store_id]=…` (sayfalı, `page[size]=100`);
  `status ∈ {active, past_due}` ve `status=cancelled` iken `ends_at > now` → `first_subscription_item.price_id` →
  `GET /v1/prices/{id}` (çalışma başına önbellek) → `unit_price × quantity`, `renewal_interval_unit/quantity` ile normalize.
  Para birimi: mağazanın para birimi (`config.storeCurrencies`). `test_mode=true` kayıtlar hariç.
- **Test modu:** `GET /v1/users/me` yanıtındaki `meta.test_mode`.
- **Deneme:** `status=on_trial`.
- **Gelir:** `GET /v1/orders` (`status ∈ {paid, refunded, partial_refund}`) → charge (`total`); `refunded_amount > 0` → refund olayı (`refunded_at`).
  `GET /v1/subscription-invoices` içinde `billing_reason ∈ {renewal, updated}` → charge. `initial` fatura siparişle aynı
  tahsilattır ve hariç tutulur; **istisna:** abonelikten 1 saatten fazla sonra kesilen `initial` fatura (deneme sonrası ilk
  tahsilat) sayılır. Geç gelen iadeleri yakalamak için her senkronizasyon 30 gün geriye bakar.
- **Limit:** 300 istek/dk.
- ✅ **Doğrulandı:** order ↔ `initial` invoice aynı para ([webhook olayları](https://docs.lemonsqueezy.com/help/webhooks/event-types));
  `prices` alanları `scheme`, `unit_price`, `unit_price_decimal`, `package_size`, `tiers`, `renewal_interval_*`
  ([price object](https://docs.lemonsqueezy.com/api/prices/the-price-object)).

### 6.3 RevenueCat

- **Taban:** `https://api.revenuecat.com/v2`, `Authorization: Bearer sk_…` (v2 secret key) + Project ID.
- **İzinler:** `charts_metrics:overview:read` (zorunlu), `charts_metrics:charts:read` (opsiyonel, günlük gelir geçmişi).
  Limit: Charts için 25 istek/dk.
- **Doğrulama + snapshot:** `GET /v2/projects/{project_id}/metrics/overview` → `mrr`, `active_subscriptions`,
  `active_trials`, `revenue` (son 28 gün), `new_customers` (son 28 gün). Para birimi USD.
- **Gelir geçmişi:** Charts API'nin `revenue` ve `refunds` grafikleri günlük çözünürlükte çekilir → `daily_revenue`
  (`source='provider'`, USD). Anahtar Charts okuyamıyorsa yalnızca snapshot'taki 28 günlük gelir gösterilir ve
  dashboard'da uyarı çıkar. Boş/eksik overview yanıtı sıfır MRR snapshot'ı **yazmaz**.
- ✅ **Doğrulandı:** uç noktalar ve izin adları ([charts & metrics](https://www.revenuecat.com/docs/api-v2/charts-and-metrics)).
  Grafik satır şekli tam belgelenmemiştir; savunmacı ayrıştırılır. Test modu API'den tespit edilemez.

### 6.4 Demo

Anahtar yok. `verify` sırasında üretilen `config.seed` ile tohumlanan deterministik veri: USD + EUR + GBP, 90 günlük geçmiş, yavaş büyüyen
MRR, ara sıra iade. Gerçek akışın tamamından (snapshot, transactions, daily_revenue) geçer.

---

## 7. Arayüz (UX/UI)

### 7.1 İndie minimalizm ilkeleri

1. **Cevap önce:** Dashboard'ın ilk satırı toplam MRR. Süs yok.
2. **Tek vurgu rengi**, geri kalan nötr gri tonları. Gölge yok; 1px ince kenarlık, bol boşluk.
3. **Sistem font yığını**; sayılarda `tabular-nums`. Harici font isteği yok.
4. Sağlayıcılar küçük renkli nokta ile ayrılır: Stripe `#635BFF`, Lemon Squeezy `#FFC233`, RevenueCat `#F2545B`, Demo nötr.
5. Açık/koyu tema `prefers-color-scheme` ile otomatik (daisyUI özel temalar `hoomuch` / `hoomuch-dark`).
6. **Sıfır istemci JS hedefi:** formlar Post/Redirect/Get, flash mesajlar çerezle.
7. **Grafikler sunucuda SVG** olarak çizilir (kütüphane yok); altında `<details>` içinde veri tablosu.
8. İçerik genişliği ~960px. Mobilde tek sütun.
9. Arayüz dili İngilizce (v1); metinler kısa ve sakin ("Connected.", "Last synced 4 min ago").
10. **CSP uyumu:** inline `style` ve inline `<script>` yok. Renkler sınıflarla veya SVG `fill`/`stroke` öznitelikleriyle.

### 7.2 Sayfalar

| Yol | İçerik |
|-----|--------|
| `/` | Landing: wordmark, tek cümlelik değer önerisi, "Get started" / "Log in", desteklenen sağlayıcı satırı. Giriş yapmışsa `/dashboard`'a yönlenir |
| `/signup`, `/login` | Tek kart, iki alan. Kayıt kapalıysa `/signup` bunu söyler |
| `/dashboard?range=7\|30\|90` | KPI şeridi (MRR büyük), dönem seçici, gelir grafiği, MRR trendi, kırılım tablosu, uyarılar. Bağlantı yoksa boş durum + "Connect" / "Try demo data" |
| `/connections` | Bağlantı listesi: renk noktası, ad, sağlayıcı, durum rozeti, son senkronizasyon, son hata |
| `/connections/new` | Sağlayıcı seçimi (4 seçenek) |
| `/connections/new?provider=…` | Dinamik form (`ProviderMeta.fields`), anahtar oluşturma adımları, gerekli izinler, uyarı |
| `/connections/:id` | Detay: durum, son hata, son snapshot'lar, son çalıştırmalar; yeniden adlandır, anahtar yenile, Sync now, sil (onay kutusu ile) |
| `/transactions?provider=&page=` | Birleşik işlem tablosu |
| `/settings` | Para birimi, parola değiştirme, hesabı silme (onay kutusu + parola) |
| `/healthz` | `{"ok":true}` |

### 7.3 Bileşenler

`Layout` (üst navigasyon), `Flash`, `KpiStat`, `DeltaBadge`, `ProviderDot`, `StatusBadge`, `EmptyState`,
`RangeTabs`, `RevenueChart` (yığılmış çubuk SVG), `MrrChart` (çizgi/alan SVG), `BreakdownTable`,
`ConnectionForm`, `DangerZone`, `RelativeTime`.

---

## 8. Güvenlik

| Konu | Karar |
|------|-------|
| Kimlik bilgisi şifreleme | `ENCRYPTION_KEY` (32 bayt, base64) Worker secret. AES-256-GCM, rastgele 12 bayt IV, biçim `v1.<iv>.<ciphertext>` (base64url). `v1` öneki anahtar rotasyonuna izin verir |
| Parola | PBKDF2-SHA256, 100.000 iterasyon (Workers üst sınırı), 16 bayt tuz, sabit zamanlı karşılaştırma. Min. 10 karakter |
| Oturum | 32 bayt rastgele token → `__Host-hm_session` çerezi (HttpOnly, SameSite=Lax, Secure, Path=/; yalnızca düz HTTP localhost'ta önek ve Secure yok). 30 gün kayan yenileme, **90 gün mutlak üst sınır**. D1'de yalnızca SHA-256 hash. Girişte eski oturum iptal edilir; parola değişince **tüm** oturumlar (mevcut dahil) iptal edilip yeni token verilir |
| CSRF | Hono `csrf()` (Origin kontrolü) + SameSite=Lax |
| HTTP başlıkları | CSP: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` + HSTS, nosniff, Referrer-Policy |
| Deneme sınırı | Sayaç, pahalı PBKDF2'den **önce** tek bir `INSERT … ON CONFLICT … RETURNING` ile atomik artırılır (paralel isteklerle aşılamaz). Giriş: e-posta + ağ başına 15 dk'da 10 (aşılınca 429). Parola teyidi (parola değiştirme, hesap silme): kullanıcı başına aynı sınır. Kayıt: ağ başına 15 dk'da 10 (hesap üretimini ve e-posta yoklamasını sınırlar). IPv6 adresleri /64 olarak gruplanır. Süresi geçen satırları cron siler |
| Yetkilendirme | Her sorgu `user_id` ile kapsamlı; bağlantı ID'leri UUID |
| Açık yönlendirme | `?next=` izin listesiyle: `/` ile başlar, `//` ile başlamaz, yalnızca yazdırılabilir ASCII, ters eğik çizgi yok (tarayıcıların sildiği tab/CR/LF ile `//evil.com` üretilemez) |
| Önbellek | Worker'ın döndürdüğü tüm sayfalar `Cache-Control: no-store` |
| Kaynak sınırı | Kullanıcı başına 25 bağlantı, koşullu `INSERT … SELECT … WHERE COUNT < 25` ile atomik |
| Loglama | Anahtar, token, parola, şifreli blob **asla** loglanmaz; sağlayıcı hata gövdeleri ≤ 300 karaktere kırpılır ve anahtar benzeri dizgeler maskelenir |

---

## 9. Proje yapısı ve sahiplik

```
hoomuch/
├─ SPEC.md                       Lead
├─ wrangler.jsonc, package.json, tsconfig.json, vitest.config.ts   Lead
├─ migrations/0001_init.sql      Lead
├─ public/                       Experience (app.css derlenir, elle düzenlenmez)
├─ src/
│  ├─ index.tsx                  Lead — uygulama kablolaması, middleware, scheduled()
│  ├─ env.ts                     Lead — Bindings, AppEnv
│  ├─ lib/                       Lead — crypto, auth, money, time, flash
│  ├─ db/queries.ts              Lead — users/sessions/connections temel sorguları
│  ├─ providers/types.ts         Lead — ADAPTÖR KONTRATI
│  ├─ providers/registry.ts      Lead — sağlayıcı meta verisi + adaptör eşlemesi
│  ├─ providers/{http,stripe,lemonsqueezy,revenuecat,demo}.ts   Data Plane
│  ├─ sync/                      Data Plane — engine, fx, repo
│  ├─ data/types.ts              Lead — OKUMA MODELİ KONTRATI
│  ├─ data/{dashboard,transactions,connections}.ts   Data Plane
│  ├─ services/connections.ts    Data Plane (imzalar Lead tarafından sabitlendi)
│  ├─ routes/                    Experience
│  ├─ views/                     Experience
│  └─ styles/app.css             Experience
└─ test/
   ├─ lib/                       Lead
   └─ providers/, sync/, fixtures/   Data Plane
```

### 9.1 Kontratlar (değiştirmek için Lead onayı gerekir)

- `src/providers/types.ts` — `ProviderAdapter`, `ProviderMeta`, `MetricsSnapshot`, `RevenueEvent`, `DailyRevenuePoint`, `RevenuePage`, `ProviderError`
- `src/data/types.ts` — `DashboardData`, `TransactionPage`, `ConnectionSummary`, `ConnectionDetail`
- `src/services/connections.ts` — `createConnection`, `renameConnection`, `rotateCredentials`, `deleteConnection`, `triggerSync`
- `src/data/*.ts` — `getDashboardData`, `listTransactions`, `listConnectionSummaries`, `getConnectionDetail`
- `src/sync/engine.ts` — `syncConnection`, `runScheduledSync`

---

## 10. Ekip ve çalışma düzeni

| Rol | Sorumluluk |
|-----|------------|
| **Lead** (ana session) | Spec, iskelet, kontratlar, entegrasyon, uçtan uca doğrulama, güvenlik incelemesi, deploy |
| **Data Plane** (alt session) | Sağlayıcı adaptörleri, HTTP/retry, sync engine, FX, okuma modelleri, servisler, testler |
| **Experience** (alt session) | Tasarım sistemi (daisyUI tema), layout, sayfalar, route'lar, SVG grafikler, erişilebilirlik |

Kurallar:
1. Her ekip **yalnızca kendi dosyalarına** yazar. Kontrat değişikliği gerekiyorsa Lead'e mesaj atılır.
2. Yeni npm bağımlılığı eklenmez (gerekirse Lead'e sorulur).
3. Commit/push yapılmaz; branch değiştirilmez.
4. Her ekip işini `npm run typecheck` (kendi dosyaları temiz) ve `npm test` ile bitirir.
5. Alt ajanlar, tanınmış şirketlerde çalışmış kıdemli uzmanlar gibi persona'larla görevlendirilir.

---

## 11. Kilometre taşları ve kabul kriterleri

| # | Kilometre taşı | Bitti sayılır, eğer… |
|---|----------------|----------------------|
| M0 | İskelet | `npm run dev` açılıyor, migration uygulanıyor, `/healthz` 200 |
| M1 | Data Plane | 4 adaptör + sync engine + FX + okuma modelleri; testler yeşil |
| M2 | Experience | Tüm sayfalar, boş durumlar, açık/koyu tema; fixture verisiyle dashboard |
| M3 | Entegrasyon | Kayıt → demo bağlantı → dolu dashboard uçtan uca; `npm run check` yeşil |
| M4 | Dağıtım | D1 oluşturuldu, migration, secret, `wrangler deploy` (kullanıcı onayıyla) |

**Definition of Done (v1):**
- Yeni kullanıcı kayıt olur, demo bağlantı ekler ve dashboard birkaç saniye içinde dolar.
- Geçersiz Stripe/LS/RC anahtarı kaydedilmez; kullanıcı sebebi görür.
- Dashboard 7/30/90 gün arasında geçiş yapar; para birimi değişince tüm tutarlar çevrilir.
- Bir bağlantının hatası dashboard'ı bozmaz; hata bağlantı satırında görünür.
- Hiçbir sayfada inline script/style yok; CSP ihlali konsolda görünmez.
- `npm run check` (typecheck + test + css) yeşil.

---

## 12. Riskler ve açık sorular

| Risk | Etki | Azaltma |
|------|------|---------|
| RevenueCat `charts:read` izni verilmemiş olabilir | RC için günlük gelir grafiği yok | Snapshot geliri + uyarı ile zarif düşüş |
| İlk senkronizasyon `waitUntil` 30 sn sınırına takılabilir | Backfill birkaç cron'a yayılır | Senk. süre sınırı (etkileşimli 20 sn, cron 60 sn) + cursor; v1.1 Queues |
| Tarihsel kur yok | Geçmiş gelir bugünkü kurla çevrilir | v1'de not olarak gösterilir; v1.1 tarihsel kur |
| Free plan CPU limiti | Giriş/senk. başarısız olabilir | Paid plan önerisi (README) |
| Stripe indirim/tiered fiyat kenar durumları | MRR sapması | Metered hariç, tiered = 0 + log; testlerle kapsanır |

### 12.1 v1.1 teknik borç (ekiplerden gelen kontrat talepleri)

- `ProviderAdapter.fetchSnapshotHistory?` (opsiyonel) — engine'deki demo'ya özel dal kalkar.
- `MetricsSnapshot.warnings?: string[]` — adaptör uyarıları (ör. Coupons izni yok) dashboard'a taşınır.
- `ProviderContext` içine `deadline` / `AbortSignal` — engine'deki geçici süre sınırı çözümünün yerini alır.
- Cron → Cloudflare Queues fan-out; sağlayıcı webhook'ları (F-17).
- Tarihsel döviz kuru; kullanıcı saat dilimine göre gün sınırları.
