# hoomuch — Ürün ve Teknik Spesifikasyon (v1.1)

> Durum: **v1.1 uygulandı** (§12.1'in tamamı ve F-17) · Tarih: 2026-11-06 · Sahibi: Lead (ana session)
>
> Bu doküman tek doğruluk kaynağıdır. Kod ile çelişirse spec kazanır; spec yanlışsa önce spec güncellenir.

---

## 1. Özet

Indie geliştiriciler gelirlerini birden fazla platformdan alır: web ürünü Stripe, Paddle, Lemon Squeezy,
Polar, Chargebee, Dodo Payments veya Gumroad ile, mobil uygulama RevenueCat, Adapty veya Superwall ile ya da doğrudan App Store ve Google Play'de satılır. Her platformun paneli, para birimi ve metrik tanımı farklıdır;
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
| F-02 | Bağlantı ekleme: **Stripe** (restricted key), **Paddle** (izinli API key), **Lemon Squeezy** (API key, opsiyonel Store ID), **Polar** (organization access token), **RevenueCat** (v2 secret key + Project ID), **Chargebee** (read-only key + site), **Dodo Payments** (read izinli API key), **Gumroad** (access token), **Adapty** (secret key), **Superwall** (organization API key + Organization ID), **App Store Connect** (team API key .p8 + Issuer ID + Key ID + vendor number), **Google Play** (service account JSON key + rapor bucket'ı) | P0 |
| F-03 | Kaydetmeden önce anahtarı canlı doğrulama; anlaşılır hata mesajı (yetki eksik, geçersiz anahtar, vb.) | P0 |
| F-04 | Bağlantıları listeleme, yeniden adlandırma, anahtar yenileme, silme (onaylı; demo veri onaysız silinir ve flash'ta "Geri ekle" sunulur) | P0 |
| F-05 | **Demo bağlantısı**: anahtarsız, deterministik örnek veri (çoklu para birimi, 90 gün geçmiş). İlk gerçek bağlantı demo veriyi kaldırır, böylece toplamlar gerçek paradır | P0 |
| F-06 | Otomatik senkronizasyon (Cron) + elle "Sync now" | P0 |
| F-07 | İlk bağlantıda 90 gün geriye dönük gelir verisi (backfill) | P0 |
| F-08 | Dashboard KPI'ları: MRR, ARR, aktif abonelik, aktif deneme, dönem geliri; önceki döneme göre değişim | P0 |
| F-09 | Bağlantı bazında kırılım tablosu (MRR payı %) | P0 |
| F-10 | Günlük gelir grafiği (bağlantı bazında yığılmış çubuk) ve MRR trend grafiği | P0 |
| F-11 | Dönem seçici: 7 / 30 / 90 gün | P0 |
| F-12 | Görüntüleme para birimi (varsayılan: kullanıcı seçmediyse, gerçek bağlantıların MRR'ının çoğunun olduğu para birimi bir kez otomatik seçilir; yoksa USD. EUR, GBP, TRY, …) ve günlük döviz kuru | P0 |
| F-13 | Bağlantı durumu: son senkronizasyon zamanı, son hata, son çalıştırmalar | P0 |
| F-14 | Birleşik işlem listesi (ödeme/iade), sağlayıcı filtresi, sayfalama | P1 |
| F-15 | Ayarlar: para birimi, parola değiştirme, hesabı tüm verisiyle silme | P1 |
| F-16 | Günlük gelir CSV dışa aktarma | P2 |
| F-17 | Webhook ile gerçek zamanlı güncelleme (v1.1): Stripe, Paddle, Lemon Squeezy, Polar, Chargebee, Dodo Payments ve Gumroad için bağlantı başına gizli bir webhook URL'si. Çağrı yalnızca bir senkronizasyon tetikler; gövdesi okunmaz, saklanmaz, loglanmaz; imza doğrulanmaz. Ayrıntı §4.1 "Webhook", güvenlik §8 | P1 |
| F-19 | Senkronizasyon uyarıları (v1.1): adaptör, eksik ya da tahmini bir rakamı (`MetricsSnapshot.warnings`, ör. Coupons izni olmayan Stripe anahtarı) kısa bir cümleyle bildirir; snapshot ile saklanır, dashboard notlarında bağlantı adıyla ve bağlantı sayfasında gösterilir, sonraki temiz snapshot'ta kalkar | P1 |
| F-20 | Saat dilimi (v1.1): günler kullanıcının saat diliminde gece yarısından gece yarısına sayılır. Dilim ilk girişte Cloudflare'in isteğe koyduğu dilimden bir kez alınır, Ayarlar'dan değiştirilir. Ayrıntı §6 "Günler" | P1 |
| F-18 | Ürün bazında kırılım ("By product" kartı), iki tablo: **MRR** — bağlantının son snapshot'ındaki MRR, ürüne göre (Stripe, App Store Connect ve Google Play böler; `ProviderMeta.mrrByProduct`); bölmeyen bağlantılar ve adsız ürünler "No product name" satırında, tablo MRR KPI'ına eşittir. **Gelir** — seçili penceredeki net gelir, işlemdeki ürün/plan adına göre (bağlantı başına); ürün adı vermeyen sağlayıcıların geliri (Stripe, Chargebee, günlük toplam veren RevenueCat, Dodo Payments, Adapty, Superwall, App Store Connect) ve adsız işlemler "No product name" satırında, tablo gelir KPI'ına eşittir. Bölünecek bir şeyi olmayan tablo gösterilmez; neden gösterilmediği notta söylenir. MRR'ı bölebilecekken bölemeyen (anahtarında Products: Read olmayan) Stripe bağlantıları notta adıyla anılır | P1 |

### 3.2 Fonksiyonel olmayan ihtiyaçlar

| ID | İhtiyaç |
|----|---------|
| N-01 | **Altyapı:** Tek Cloudflare Worker (Hono) + Workers Static Assets + D1 + Cron Triggers. Wrangler ile geliştirme/dağıtım. Harici veritabanı yok. |
| N-02 | **Performans:** Sunucu tarafı render (React SSR) HTML, tarayıcıda hydrate edilir; istemci paketi sayfa başına bölünür (grafiksiz sayfalar Recharts indirmez). Formlar düz POST formu olduğu için hydrate olmadan da çalışır; dashboard yalnızca D1'den okur (sağlayıcıya canlı çağrı yapmaz). |
| N-03 | **Güvenlik:** API anahtarları AES-256-GCM ile şifreli; parolalar PBKDF2-SHA256 (100.000 iterasyon); HttpOnly oturum çerezi; CSRF koruması; sıkı CSP; giriş deneme sınırı; gizli bilgi asla loglanmaz. |
| N-04 | **Gizlilik:** Son müşterilerin e-posta/isim gibi kişisel verileri **saklanmaz**. Yalnızca tutar, para birimi, zaman, harici ID, ürün/plan adı. |
| N-05 | **Dayanıklılık:** Bir sağlayıcının hatası diğerlerini etkilemez; 429/5xx'te üstel geri çekilme; idempotent upsert; sayfalı çekim ve cursor ile kaldığı yerden devam. |
| N-06 | **Doğruluk:** Tüm tutarlar **minor unit tamsayı** (kuruş/cent); para birimi ISO 4217 büyük harf; ondalıksız para birimleri (JPY, KRW…) doğru. |
| N-07 | **Erişilebilirlik:** Semantik HTML, WCAG AA kontrast, klavye ile gezinme, grafikler için veri tablosu alternatifi. |
| N-08 | **Test edilebilirlik:** Sağlayıcı adaptörleri enjekte edilen `fetch` ile saf; fixture tabanlı Vitest birim testleri. |
| N-09 | **Self-host:** `wrangler deploy` + tek secret (`ENCRYPTION_KEY`) ile ayağa kalkar. |
| N-10 | **Gözlemlenebilirlik:** Workers Observability açık; her senkronizasyon `sync_runs` tablosuna yazılır. |

### 3.3 Kapsam dışı (v1)

Takım/organizasyon hesapları · Creem (API'si gelir geçmişine yetmiyor, §6.9) · Whop, Recurly, FastSpring
(anahtar kapsamı, kişisel veri veya asenkron rapor zorunluluğu nedeniyle ertelendi) · kohort/LTV analizi ·
e-posta raporları · webhook yükünü okuyup işleme (webhook yalnızca senkronizasyon tetikler, F-17) · sağlayıcıda webhook
kaydetme (salt okunur kuralı; URL'yi kullanıcı elle ekler) · OAuth (Stripe Connect) ile bağlama.

---

## 4. Mimari

```
Tarayıcı ──HTTPS──▶ Cloudflare Worker  (tek deploy)
                    ├─ Static Assets ─ /app.css, /client/*.js, /fonts, /favicon.svg   (Worker'ı çağırmadan servis edilir)
                    ├─ Hono router + React SSR sayfaları (tarayıcıda hydrate)
                    ├─ D1 (SQLite) ─ users, sessions, connections, snapshots,
                    │                transactions, daily_revenue, fx_rates, sync_runs
                    ├─ POST /webhooks/:id/:token ─▶ (sağlayıcıdan) senkronizasyonu kuyruğa koyar
                    ├─ scheduled()  ──▶ FX + vadesi gelenleri kuyruğa koyar ──▶ Queue `hoomuch-sync`
                    └─ queue()      ──▶ sync engine (mesaj başına bir bağlantı) ──▶ Stripe API
                                                   ├──▶ Paddle Billing API
                                                   ├──▶ Lemon Squeezy API
                                                   ├──▶ Polar API
                                                   ├──▶ RevenueCat API v2
                                                   ├──▶ Chargebee API v2
                                                   ├──▶ Dodo Payments API
                                                   ├──▶ Gumroad API
                                                   ├──▶ Adapty Export Analytics API
                                                   ├──▶ Superwall API (charts + query)
                                                   ├──▶ App Store Connect API (Sales and Trends raporları)
                                                   ├──▶ Google Cloud Storage (Play Console raporları) + Android Publisher API
                                                   └──▶ frankfurter.dev v2 (ECB + merkez bankaları)
```

| Katman | Seçim |
|--------|-------|
| Runtime | Cloudflare Workers (`compatibility_date` 2026-11-01) |
| Router / SSR | Hono 4 (route'lar) + React 19 (`renderToString`, tarayıcıda `hydrateRoot`) |
| UI | coss ui (Base UI üzerine, `src/components/ui`), Lucide ikonlar, Motion (gerektiğinde) |
| Grafik | shadcn Charts / Recharts |
| Font | Geist Sans + Geist Mono (kendi sunucumuzdan, `public/fonts`) |
| Stil | Tailwind CSS 4 (+ radial-gradient; Magic UI ışın, grain ve dither shader arka planları), Tailwind CLI ile `public/app.css`'e; istemci paketi esbuild ile `public/client/`'a derlenir (Wrangler `build` adımı) |
| Veritabanı | Cloudflare D1, `migrations/` |
| Zamanlama | Cron Triggers `*/30 * * * *` + Cloudflare Queues (`hoomuch-sync`, consumer `max_batch_size: 1`, `max_concurrency: 10`) |
| Test | Vitest (Node ortamı; adaptörler ve saf fonksiyonlar) |
| Dil | TypeScript (strict) |

### 4.1 Akışlar

**Bağlantı ekleme:** form → `parseInput` (alan doğrulama) → `adapter.verify` (canlı API çağrısı, 20 sn son
tarih) → kimlik bilgisi şifrelenir → D1 → ilk senkronizasyon kuyruğa (`initial`) → `/connections/:id`.

**Kuyruk (v1.1):** Her senkronizasyon `hoomuch-sync` kuyruğunun tüketicisinde, çağrı başına tek bağlantı olarak çalışır;
böylece her biri kendi alt istek bütçesini ve 15 dk duvar saatini alır (eskiden cron'un ya da `waitUntil`'in 30 sn'si).
Mesaj `{v: 1, connectionId, kind, at}`. Kuyrukta tekilleştirme olmadığı için `connections.queued_at` (migration 0007) bir
bağlantının yolda bir senkronizasyonu olduğunu işaretler: cron, "Sync now" ve anahtar yenileme ikinciyi eklemez. İşaret tek
bir koşullu `UPDATE … RETURNING` ile alınır (işaret yoksa ya da 15 dk ve daha eskiyse) ve mesaj yalnızca işareti alınan
bağlantılar için gönderilir; aynı anda gelen iki üreticiden yalnızca biri gönderir. Senkronizasyon kilidi alınınca işaret
temizlenir; 15 dk içinde başlamazsa kaybolmuş sayılır. Biten senkronizasyon sonucu ne olursa olsun ack'lenir (hata
bağlantıya yazılır); yalnızca senkronizasyon dışındaki bir çökme ya da kilit alınırken D1 hatası yeniden denenir
(`max_retries: 3`; işaret kalır). Teslimat en az bir kezdir: `at`'inden sonra başlamış başarılı bir senkronizasyon varsa mesaj
iş yapmadan ack'lenir. Meşgul bağlantıyı bulan ilk deneme ack'lenip işaretini bırakır; webhook mesajı ise 60 sn sonra
yeniden dener. Yeniden teslim edilen mesaj (`attempts > 1`) meşgul bulursa kilidi kendi ölü denemesi tutuyor olabilir: kilit
bayatlayınca (10 dk) yeniden dener; böylece webhook mesajı da `max_retries` içinde (60 + 600 sn) bayat kilidi devralır.
`wrangler deploy` kuyruk yoksa oluşturur.

**Senkronizasyon (bir bağlantı):**
1. `status='syncing'`, `sync_runs` kaydı aç.
2. `fetchSnapshot` → bugünün `snapshots` satırını upsert et.
3. `fetchRevenue` → `revenue_cursor` varsa oradan, yoksa `revenue_synced_until − 2 gün` (ilk sefer: şimdi − 90 gün).
   Dönen `events` → `transactions` upsert; etkilenen günler için `daily_revenue` yeniden hesaplanır.
   Dönen `daily` (RevenueCat gibi) → doğrudan `daily_revenue` upsert (`source='provider'`).
   Adaptörün `fetchSnapshotHistory`'si varsa (demo, Adapty, Superwall) ve bağlantının henüz hiç snapshot'ı yoksa (ilk
   senkronizasyon ya da başka bir hesabı okuyan anahtara geçişte veriler silindikten sonra) geçmiş günlerin snapshot'ları
   eklenir; var olan gün ezilmez. Bugünün satırı yazılınca bir daha sorulmaz; geçmiş çağrısı ya da gelir adımı hata verse de.
4. Sayfa bütçesi dolduysa `revenue_cursor` saklanır (sonraki çalışmada devam); bittiyse cursor temizlenir,
   `revenue_synced_until` ilerletilir.
5. `status='ok'|'error'`, `last_error`, `last_synced_at`, `sync_runs` kapanır.

**Cron:** Her 30 dakikada bir: önce FX (günde bir; kur geçmişi kurulumdan/yükseltmeden sonra bir kez doldurulur),
sonra vadesi gelen **en fazla 100 bağlantı** (kiracı başına sıralı, `queued_at`'i taze olanlar hariç) tek `sendBatch`
ile kuyruğa konur. Her senkronizasyonda sayfa bütçesi gelir için 20, snapshot için 400 istek; dakikalık limiti düşük
sağlayıcıların adaptörü snapshot'ınkini düşürür (`capBudget`: Lemon Squeezy 200, Paddle ve Dodo Payments 160, Chargebee 90;
§6), böylece gelirin 20'siyle bir senkronizasyon limitin 3/4'ünü geçmez. Son tarih 4 dk (`ProviderContext.deadline`:
snapshot payı %75, yani 3 dk, kalan gelire), son tarihten 5 sn sonra `ProviderContext.signal` uçuştaki istekleri keser.
Snapshot devam ettirilemez: bütçe ya da süre yetmezse o senkronizasyonda MRR yazılmaz. Kilit 10 dk sonra bayat sayılır;
canlı bir senkronizasyon (en çok 4 dk + 5 sn + D1 yazımları) bu süreye yaklaşmaz, yani başkası devralmaz.

**Elle senkronizasyon:** Aynı bağlantı için 60 saniyede bir; yolda bir senkronizasyon varsa ikincisi eklenmez. Kuyruğa
konur; istek hemen döner (`?sync=<istek anı>`), sayfa meta refresh ile çalışmayı izler ve bitince sonucu gösterir.
Anahtar yenileme de aynı yolu kullanır; yolda bir mesaj varsa ikincisini eklemez (tüketici anahtarı çalışırken okur, o
mesaj yeni anahtarla çalışır).

**Webhook (F-17, v1.1):** Bağlantı sayfasında "Real-time updates" → **Turn on**: `webhook_nonce` (rastgele) yazılır ve
URL `/webhooks/<id>/<token>` gösterilir; `token = base64url(HMAC-SHA256(HKDF(ENCRYPTION_KEY, "hoomuch webhook url v1"),
"<id>:<nonce>"))`. Token saklanmaz; sahip URL'yi her zaman görebilir, **New URL** nonce'u yeniler (eski URL anında
geçersiz), **Turn off** siler. Sağlayıcı çağırınca: kimlik/nonce/token sabit zamanlı doğrulanır, `webhook_last_at`
yazılır ve yolda bir senkronizasyon yoksa `webhook` türünde bir mesaj **60 sn gecikmeyle** (aynı bağlantının webhook
senkronizasyonları en az 5 dk arayla) kuyruğa konur; böylece bir ödemenin birkaç olayı tek senkronizasyon olur. Yanıt
`200 {"ok":true}`; geçersiz her URL (webhook sunulmayan bir sağlayıcının bağlantısı dahil) aynı `404 {"ok":false}`;
D1, anahtar ya da kuyruk hata verirse `503` (sağlayıcı yeniden dener; loga yalnızca hatanın adı yazılır). Gövde
hiç okunmaz. Sunulan sağlayıcılar ve kurulum adımları `ProviderMeta.webhook`'ta (Stripe, Paddle, Lemon Squeezy, Polar,
Chargebee, Dodo Payments, Gumroad). App Store Connect ve Google Play (raporlar bir gün geride), Adapty (ortam başına tek
URL) ve RevenueCat, Superwall (grafikler kendi takviminde yenilenir) için sunulmaz.

**Dashboard:** Yalnızca D1'den okur → tipik yanıt < 150 ms.

### 4.2 Limitler ve ölçeklenme

- PBKDF2 100k iterasyon ve senkronizasyon, Free plan'ın 10 ms CPU limitini aşabilir → **Workers Paid önerilir**.
- Queues Free plan'da da var: günde 10.000 işlem; bir senkronizasyon ≈ 3 işlem, yani günde ≈ 3.300 senkronizasyon
  (varsayılan saatlik aralıkta ≈ 130 bağlantı). Paid'de ayda 1M işlem dahildir.

---

## 5. Veri modeli (D1)

Kaynak: [`migrations/`](migrations/) (`0001_init.sql`; `0002` para birimi kaynağı; `0003` `connections.provider` üzerindeki CHECK'i kaldırır, geçerli kimlikleri `isProviderId` denetler; `0004` e-posta doğrulaması; `0005` `snapshots.mrr_by_product`; `0006` `snapshots.warnings`; `0007` `connections.queued_at`; `0008` `connections.webhook_nonce`, `webhook_last_at` ve `sync_runs.kind`'a `webhook`; `0009` `users.timezone`, `timezone_source`). Özet:

| Tablo | Anahtar | Amaç |
|-------|---------|------|
| `users` | `id` | e-posta (NOCASE, unique), parola hash'i, `base_currency`, `currency_source` (`default` / `inferred` / `chosen`, migration 0002), `email_verified_at` (adres onaylandığı an; `NULL` = onaylanmadı, migration 0004), `timezone` (IANA, varsayılan `UTC`) ve `timezone_source` (`default` / `inferred` / `chosen`, migration 0009) |
| `sessions` | `id` = sha256(token) | oturumlar; token'ın kendisi saklanmaz |
| `email_verifications` | `id` = sha256(token) | tek kullanımlık e-posta onay bağlantıları (`user_id`, `expires_at`); token'ın kendisi saklanmaz |
| `login_attempts` | `key` = sha256(email\|ip) | giriş deneme sınırı |
| `connections` | `id` (UUID) | sağlayıcı, ad, **şifreli** kimlik bilgisi, `config` (JSON), durum, cursor, `queued_at` (yolda bir senkronizasyon, 0007), `webhook_nonce` (`NULL` = webhook kapalı) ve `webhook_last_at` (0008) |
| `snapshots` | (`connection_id`, `day`) | günlük metrik anlık görüntüsü; gün, sahibin yerel günü (v1.1; önceki satırlar UTC); MRR **MoneyMap JSON** (`{"USD":12300,"EUR":4500}`); `mrr_by_product` (migration 0005): MRR'ın ürüne göre dağılımı, `[{name, mrr, subscriptions}]` JSON, en fazla 500 ürün; bölmeyen sağlayıcılarda NULL; `warnings` (0006): o senkronizasyonun sayamadıkları, en fazla 5 cümle × 200 karakter |
| `transactions` | (`connection_id`, `external_id`) | ödeme/iade olayları (PII yok) |
| `daily_revenue` | (`connection_id`, `day`, `currency`) | birleşik günlük gelir, **UTC** günü. İşlem bazlı sağlayıcılarda `transactions`'tan türetilir (okuma modelleri bunları yerel güne göre `transactions`'tan gruplar, §6 "Günler"); günlük toplam veren sağlayıcılarda (`source='provider'`) doğrudan okunur |
| `fx_rates` | `day` | USD bazlı kurlar (JSON), her kur kendi tarihinde; `json_patch` ile birleşir (aynı güne yeni gelen kur eskisinin yerine geçer). Boş satır (`{}`) yalnızca geçmişin çekildiğini işaretler. `fetched_at` günlük çekimin satırı son yazdığı an (yalnızca geçmiş doldurmanın yazdığı günlerde 0); geçmiş doldurma günlük çekim yerine sayılmaz |
| `sync_runs` | `id` | senkronizasyon geçmişi |

**MoneyMap:** Bir sağlayıcı birden fazla para biriminde satış yapabilir. MRR ve dönem geliri
`{ [ISO kodu]: minor unit }` olarak saklanır; görüntüleme anında kullanıcının para birimine çevrilir.

---

## 6. Metrik tanımları

Tüm tutarlar **ISO 4217 minor unit** cinsinden tamsayıdır. Görüntülemede `Intl.NumberFormat` kullanılır.

**Minor unit hane sayısı** (`currencyExponent`, `src/lib/money.ts`): SIX'in ISO 4217 listesinden (list one, 2026-09-17)
alınan sabit tablo. USD, EUR, HUF, IDR, COP, PKR 2 hane; JPY, KRW, ISK, UGX 0; KWD, BHD, IQD 3; CLF 4. Tablo tüm aktif
kodları ve 2017'den beri kaldırılmış birkaç kodu (SLL, HRK, BGN, MRO…) içerir; `Intl` yalnızca ISO 4217 dışındaki kodlarda
yedektir. `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits` hane sayısı olarak **kullanılmaz**: o CLDR'ın
*gösterim* hassasiyetidir, ICU sürümüne ve çalışma ortamına (Node, workerd) göre değişir ve HUF, IDR, COP, PKR, AFN, ALL,
IRR, KPW, LAK, LBP, MGA, MMK, SOS, SYP, YER (ISO: 2) ile IQD (ISO: 3) için 0 döner. Eskiden bu değer kullanıldığı için bu para
birimlerindeki tutarlar 100× (IQD 1000×) büyük görünüyordu. Gösterim CLDR yuvarlamasını korur (`displayDigits` = CLDR
haneleri, minor unit ile sınırlı): Stripe'tan gelen HUF 4.990,00 (499000) → "HUF 4,990".

**Sağlayıcı birimleri:** Adaptörler tutarı ISO minor unit'e çevirip yazar. Sağlayıcının birimi ISO'dan ayrılıyorsa çevrim
adaptörde yapılır (Stripe: §6.1). Ondalıklı major unit döndürenler (RevenueCat ve USD raporlayan diğerleri) `toMinor` kullanır.

**Eski kayıtlar:** Saklanan tamsayılar yeniden yazılmadı, yalnızca okunuşları değişti. Stripe ve Lemon Squeezy'nin HUF, IDR,
COP, PKR (ve yukarıdaki diğer) satırları zaten ISO birimindeydi: yeniden senkronizasyon **gerekmez**, düzeltme hemen görünür.
Stripe'ın ISK, UGX ve MGA satırları Stripe biriminde yazılmıştı: ISK/UGX 100× büyük kalır, MGA (eskiden doğru görünen)
artık 100× küçük okunur. "Sync now"
yalnızca bugünün snapshot'ını ve son 2 günü yeniler; geçmişi düzeltmek için bağlantıyı kaldırıp yeniden eklemek gerekir
(90 günlük gelir yeniden çekilir, eski snapshot'lar silinir). RevenueCat USD raporladığı için etkilenmez.

| Metrik | Tanım |
|--------|-------|
| **MRR** | Aktif (ücretli) aboneliklerin aylığa normalize edilmiş tekrarlayan tutarı. Deneme süresindekiler **dahil değil**. Dönem sonunda iptal edilecek ama hâlâ aktif olanlar **dahil**. |
| **ARR** | MRR × 12 |
| **Aktif abonelik** | Ücretli aktif abonelik sayısı (past_due dahil, deneme hariç) |
| **Aktif deneme** | Deneme süresindeki abonelik sayısı |
| **Dönem geliri** | Seçili penceredeki günlük gelirin toplamı (yerel günler, §6 "Günler"): brüt tahsilat − iadeler. Sağlayıcı komisyonları **düşülmez** (v1). **Vergi:** merchant of record sağlayıcılarda (Paddle, Lemon Squeezy, Polar, Dodo Payments, Gumroad) KDV/satış vergisi satıcının parası değildir ve hariç tutulur (tahsilat − vergi; iadeler aynı oranda). Ödeme işlemcisi/faturalama platformlarında (Stripe, Chargebee) tutar "tahsil edildiği gibi"dir, çünkü işlemler vergiyi ayrı vermez. Uygulama mağazası verisi (RevenueCat, Adapty, Superwall, App Store Connect, Google Play) sağlayıcının kendi Revenue tanımıyla gelir: kullanıcının ödediği brüt tutar, vergi dahil, mağaza komisyonu düşülmeden. MRR vergi hariç hedeflenir; sağlayıcının vergiyi ayırmadığı durumlar (Paddle metrik MRR'ı, Dodo `tax_inclusive` abonelikler, Stripe Tax açık vergi dahil fiyatlar) ilgili bölümde belirtilir. |
| **Değişim %** | MRR/abonelik/deneme: pencerenin başındaki en yakın snapshot'a göre. Gelir: bir önceki eşit uzunluktaki pencereye göre. Veri yoksa `null` (UI'da "—"). |

**Aylığa normalize:** `day → ×365/12`, `week → ×52/12`, `month → ×1`, `year → ×1/12`; hepsi `interval_count`'a bölünür.
Sonuç en yakın tamsayıya yuvarlanır.

**Döviz (v1.1):** [frankfurter.dev v2](https://frankfurter.dev), USD baz: merkez bankaları ve resmî kaynaklardan
harmanlanmış 181 para birimi, ECB'nin yayımladığı yerde ECB'nin kendi kuru (her çekimde önce harmanlanmış, üstüne ECB
yazılır; `providers=ecb`). Her kur kendi yayın tarihine yazılır. Günde bir çekilir; kurulumdan ya da yükseltmeden sonra cron
bir kez yaklaşık 200 günlük geçmişi (kullanımdaki para birimleri için) doldurur; ECB'nin geçmişi alınamazsa harmanlanmış
kurlar saklanır, ECB'ninki sonraki cron'larda (her birinde tek istekle) en çok 3 gün yeniden denenir. **Gelir** (günlük
çubuklar, gelir KPI'ı ve önceki dönemi, ürün geliri, takvim, işlem listesi) **kendi gününün kuruyla** (o gün ya da
öncesindeki en yeni kur) çevrilir; **MRR** ve trendi **en güncel kurla** (trend iş değişimini göstersin, kur oynaklığını
değil). Bir günün geliri bağlantı ve para birimi başına tek tutar olarak çevrilir, parçaları bu toplama tamamlanır: ürün
satırları yuvarlama farkını en büyük kalanlara dağıtarak gelir KPI'ına eşit olur; takvimde net dashboard çubuğuyla
aynıdır, brüt tek başına çevrilir, iade ikisinin farkıdır. Geçmişi
başlamadan önceki günler o para biriminin en eski kurunu, geçmişi hiç olmayan para birimi güncel kuru kullanır. Kuru
olmayan para birimi toplamdan hariç tutulur ve dashboard'da uyarı gösterilir.

**Günler (v1.1):** Günler kullanıcının saat diliminde (`users.timezone`) gece yarısından gece yarısına sayılır: "bugün",
7/30/90 pencereleri, önceki dönem, takvim ve `?day=`. `daily_revenue` UTC günüyle saklanmaya devam eder; işlem bazlı
sağlayıcıların geliri okuma anında `transactions`'tan yerel güne göre gruplanır (D1'de saat dilimi olmadığı için her
DST aralığının farkı JS'te hesaplanıp SQL `CASE` ile uygulanır). Günlük toplam veren sağlayıcılar yeniden gruplanamaz ve
kendi günlerini korur (`ProviderMeta.dayZone`): RevenueCat, Dodo Payments, Adapty, Superwall UTC; App Store Connect
Pasifik saati. Kullanıcının dilimi farklıysa dashboard bunu söyler. Snapshot günü sahibin yerel günüdür; ilk backfill
yerel gece yarısından başlar. Dilim batıya değişince eski dilimin "yarın"ına yazılmış snapshot ~25 saate kadar kalabilir;
bu yüzden dashboard ve bağlantı sayfası snapshot'ları bugüne (dahil) kadar okur. Tarih içermeyen Google Play satırları
UTC öğlene konur, ±12 saatlik her dilimde kendi tarihinde kalır. Dilim IANA'nın güncel adıyla, tek yazımla saklanır
(`asia/calcutta` → `Asia/Kolkata`; ICU'nun hâlâ eski adıyla andığı dilimler de listede güncel adıyla görünür). Sabit
farklar (`+05:30`, `Etc/GMT+5`), POSIX kuralları (`EST5EDT`) ve listede gösterilemeyen her şey reddedilir. Cloudflare'in
dilimi de aynı denetimden geçer; geçmezse varsayılan (UTC) korunur. Saklanmış geçersiz bir dilim UTC sayılır.

### 6.1 Stripe

- **Kimlik:** Restricted key (`rk_live_…`) önerilir; `sk_…` kabul edilir ama uyarı gösterilir. `*_test_*` anahtarlar test modu olarak etiketlenir.
- **Sürüm:** `Stripe-Version: 2026-10-28.endive` sabitlenir.
- **Gerekli izinler (read):** Subscriptions, Prices, Balance (balance transactions). İsteğe bağlı: Coupons (yoksa MRR indirimsiz hesaplanır) ve Products (yoksa MRR ürüne göre bölünmez); ikisinde de doğrulamada uyarı gösterilir, senkronizasyon başarısız olmaz. Tax Rates izni gerekmez: vergi oranları aboneliğin içinde gelir.
- **Doğrulama:** `GET /v1/subscriptions`, `/v1/prices`, `/v1/balance_transactions`, `/v1/coupons` ve `/v1/products` (hepsi `limit=1`; doğrulama bütçesi 5). İlk üçünden 403 gelirse eksik izin adıyla hata verilir; coupons ya da products'tan 403 gelirse anahtar kabul edilir ve uyarı gösterilir.
- **MRR:** `GET /v1/subscriptions?status=active` ve `status=past_due` (sayfalı, `limit=100`, `expand[]=data.discounts` ve `data.items.data.discounts`).
  Her item: `price.recurring.{interval, interval_count}`, `price.unit_amount` (yoksa `unit_amount_decimal`), `quantity`. `usage_type=metered` olanlar ve deneme teklifi
  süren (`current_trial`) item'lar hariç. Kademeli (tiered) fiyatlar `GET /v1/prices/{id}?expand[]=tiers` ile (çalışma başına önbellek) hesaplanır: `volume`: tüm adet,
  düştüğü kademenin birim fiyatıyla + o kademenin `flat_amount`'u; `graduated`: her dilim kendi kademesinin fiyatıyla + ulaşılan her kademenin `flat_amount`'u (adet 0
  ise ilk kademenin `flat_amount`'u). Bu API sürümünde indirim yalnızca kupon ID'si taşır; kupon `GET /v1/coupons/{id}` ile çekilip (çalışma başına önbellek)
  `percent_off`/`amount_off` uygulanır. Vergi hariçtir: item'ın `tax_rates`'i (yoksa aboneliğin `default_tax_rates`'i) içindeki `inclusive` oranlar, indirimlerden sonra
  `tutar / (1 + Σ oran)` ile çıkarılır. Stripe Tax (`automatic_tax`) açıksa oran bilinmez; vergi dahil fiyat olduğu gibi kalır ve loglanır. Müşteri düzeyindeki
  indirimler uygulanmaz (Customers izni müşteri kişisel verisini açar). Para birimi: `subscription.currency`. Sayfa bütçesi (400 istek) ~35.000 aktif aboneliğe yeter; Stripe yavaş yanıt verirse önce 3 dk'lık snapshot süresi dolar.
- **Ürüne göre MRR (`mrrByProduct`):** her aboneliğin MRR'ı, indirim ve vergiden sonra, item'larının ürününe (`price.product`) bölünür;
  tam minor unit'e en büyük kalan yöntemiyle yuvarlanır, toplamı aboneliğin MRR'ına eşittir. Bir abonelik ödediği her ürünün altında bir kez sayılır;
  %100 indirimli item'ın ürünü sayılmaz. Adlar abonelikler okunduktan sonra `GET /v1/products?ids[]=…&limit=100` ile (100 ürün başına bir istek,
  snapshot bütçesinden) okunur. Bu okuma snapshot'ı asla düşürmez: 403 (Products: Read yok), biten bütçe ya da Stripe hatası → bölüm `null`, MRR aynen
  yazılır ve loglanır. Listede dönmeyen ürün adsız kalır ("No product name"). Yalnızca ürün/plan adı okunur; müşteri verisi yok (N-04).
- **Aktif abonelik:** MRR'ı 0'dan büyük `active` + `past_due` abonelikler (Stripe'ın tanımı). Ücretsiz plan, %100 indirimli, yalnızca metered ya da yalnızca deneme
  teklifli abonelikler sayılmaz. Stripe müşteri sayar, hoomuch abonelik sayar.
- **Deneme:** `status=trialing` abonelikler (eski `trial_end` denemesi 1 sayılır; ücretsiz deneme tekliflerinden oluşan abonelikte her teklifli item ayrı sayılır) +
  `active`/`past_due` aboneliklerde deneme teklifi süren her item.
- **Gelir:** `GET /v1/balance_transactions?created[gte]=…` — `charge`/`payment` → charge (brüt `amount`, `fee`);
  `refund`/`payment_refund` → refund (negatif). Para birimi: bakiye (settlement) para birimi. Tutar tahsil edildiği gibidir (vergi dahil; §6).
  Kısmi capture'da tam yetkilendirme `charge`, yakalanmayan kısım `refund` (`partial_capture_reversal`) olarak gelir; brüt ve iadeler biraz yüksek, net doğrudur.
  Test clock'a bağlı abonelikler listelenmez.
  **Ürün adı yok** (`description = null`, `productNames: false`): balance transaction açıklaması serbest metindir (çoğu zaman müşteri e-postası
  içerir). `2025-03-31.basil`'den beri Charge ve PaymentIntent faturasını göstermez; ödemeden ürüne tek yol Invoice Payment aramasıdır
  (`/v1/invoice_payments`, ödeme başına ya da tarihe göre). Bu, müşteri kişisel verisini açan Invoices ve Charges (balance transaction sources)
  okuma izni ister ve ödeme başına bir istek gelir bütçesine (20/senk., 2 gün örtüşme) sığmaz. Stripe'ın ürün kırılımı bu yüzden MRR'dandır.
- **Tutar birimi** ([currencies](https://docs.stripe.com/currencies#zero-decimal)): Stripe tamsayıları ISO minor unit ile
  aynıdır, üç istisna `fromStripeAmount` ile çevrilir: MGA Stripe'ın sıfır ondalıklı listesinde (ISO 2 → ×100); ISK ve UGX
  "geriye uyumluluk için" iki ondalıklı gönderilir, 5 ISK = `500` (ISO 0 → ÷100). UGX sıfır ondalıklı listede de geçiyor;
  özel durum notu ve Stripe'ın kendi istemcisi (stripe-android `SERVER_DECIMAL_DIGITS`) 2 dediği için 2 kabul edilir. HUF ve
  TWD tahsilatta iki ondalıklıdır (sıfır ondalık yalnızca payout için). Çevrim fiyat, kupon `amount_off`, `amount` ve `fee`
  alanlarının hepsine uygulanır; MRR'da aylığa normalize etmeden önce yapılır.

### 6.2 Lemon Squeezy

- **Taban:** `https://api.lemonsqueezy.com/v1`, JSON:API (`Accept: application/vnd.api+json`), `Authorization: Bearer`.
- **Kimlik:** API key (tam yetkili — UI'da uyarı gösterilir). Opsiyonel Store ID; boşsa anahtarın erişebildiği tüm mağazalar.
- **Doğrulama:** `GET /v1/users/me` + `GET /v1/stores` (mağaza para birimleri `config`'e yazılır).
- **MRR:** `GET /v1/subscriptions?filter[store_id]=…&filter[status]=…` (sayfalı, `page[size]=100`);
  `status ∈ {active, past_due}` ve `status=cancelled` iken `ends_at > now` → `first_subscription_item.price_id` →
  `GET /v1/prices/{id}` (çalışma başına önbellek) → `unit_price × quantity` (package: paket sayısı × `unit_price`;
  volume/graduated: `tiers`), `renewal_interval_unit/quantity` ile normalize. Kademesi olmayan volume/graduated ve
  usage-based fiyatlar fiyatlandırılamaz (MRR'a eklenmez, abonelik aktif sayılır).
  İptal edilmiş ama denemeden hiç çıkmamış abonelik (LS iptalde `trial_ends_at`'i boşaltır): `first_subscription_item = null`
  ya da `ends_at`, `created_at` + fiyatın `trial_interval_*` süresine denk geliyorsa → deneme sayılır, MRR'a girmez.
  **İndirim:** `GET /v1/discounts?filter[store_id]=…` → `duration ∈ {forever, repeating}` olanlar için
  `GET /v1/discount-redemptions?filter[discount_id]=…`; redemption'ın `order_id`'si aboneliğin `order_id`'si ise
  redemption'daki `discount_amount`/`discount_amount_type` (percent | fixed, her ödemeden) dönem tutarına uygulanır.
  `repeating` yalnızca redemption'dan itibaren `duration_in_months` dolana kadar; `once` MRR'ı etkilemez.
  Sayfa bütçesi yetmezse MRR indirimsiz hesaplanır ve loglanır (kısmi uygulama yok).
  Para birimi: mağazanın para birimi (`config.storeCurrencies`). Anahtarın moduna uymayan `test_mode` kayıtları hariç.
- **Test modu:** `GET /v1/users/me` yanıtındaki `meta.test_mode`.
- **Deneme:** `status=on_trial` + yukarıdaki iptal edilmiş denemeler.
- **Gelir (vergi hariç):** LS satıcının yerine satış yapan taraftır (merchant of record); KDV/satış vergisi satıcının parası değildir.
  `GET /v1/orders` (`status ∈ {paid, refunded, partial_refund}`) → charge (`total − tax`);
  `GET /v1/subscription-invoices` içinde `billing_reason ∈ {renewal, updated}` → charge (`total − tax`).
  `initial` fatura: aboneliğin checkout siparişi (`subscription.order_id`) `total > 0` ise aynı tahsilattır ve hariç
  tutulur; `$0` checkout (ücretsiz deneme) ise deneme sonrası ilk gerçek tahsilattır ve sayılır. Sipariş taramada
  görülmediyse `GET /v1/orders/{id}` ile bakılır (bütçe yetmezse imleç bir sonraki senkronizasyonda devam eder).
  İade: kayıt başına tek olay, sabit kimlik; tutar kümülatif `refunded_amount × (total − tax) / total`; tarih
  `refunded_at` (yalnızca tam iadede dolu), yoksa `updated_at`. Birden çok kısmi iade tek olayda birleşir ve son
  değişiklik tarihine taşınır. Geç gelen iadeleri yakalamak için her senkronizasyon 30 gün geriye bakar.
  Tutarlar mağaza para birimindedir; LS tahsilatı USD olarak işler (`*_usd` alanları), aradaki kur farkı yansıtılmaz.
  Bu sürümden önce senkronize edilmiş ve 30 günlük geri bakışın dışında kalan LS geçmişi vergi dahil kalır (motor eski
  satırları silmez); geçmişi yeniden hesaplamak için bağlantı silinip yeniden eklenir.
- **Tutar birimi:** Belgeler yalnızca "in cents" der ve iki ondalıklı olmayan para birimleri için ne anlama geldiğini
  söylemez. Tutarlar ISO minor unit kabul edilir (JPY/KRW tam, HUF/IDR yüzde birlik); ISK, UGX ve MGA doğrulanmadı.
- **Limit:** 300 istek/dk, `Retry-After` yok. 429'da yeniden denenmez: gelir okuduğunu ve imleci döndürür, snapshot başarısız olur.
  Snapshot en çok 200 istek yapar (gelirin 20 isteğiyle birlikte limitin en çok 3/4'ü); daha büyük bir mağaza 429 yerine "tek senkronizasyonda okunamayacak kadar abonelik" hatası alır.
- ✅ **Doğrulandı:** `prices` alanları `scheme`, `unit_price` (volume/graduated'da kullanılmaz), `unit_price_decimal`,
  `package_size`, `tiers`, `renewal_interval_*`, `trial_interval_*` ([price object](https://docs.lemonsqueezy.com/api/prices/the-price-object));
  denemede `trial_ends_at` / `first_subscription_item` davranışı ([subscription object](https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object));
  indirim ve redemption alanları ([discount object](https://docs.lemonsqueezy.com/api/discounts/the-discount-object));
  USD işleme ([para birimleri](https://docs.lemonsqueezy.com/help/payments/currencies)).
- ⚠️ **Çıkarım (belgelenmemiş):** order ↔ `initial` invoice'ın aynı para olduğu, checkout webhook sırasından
  (`order_created` + `subscription_created` + `subscription_payment_success`) çıkarılmıştır
  ([webhook olayları](https://docs.lemonsqueezy.com/help/webhooks/event-types)); bu yüzden karar zamanlamaya değil checkout siparişinin tutarına dayanır.
- **Durum (2026-01):** LS, satıcıları Stripe Managed Payments'a taşımayı hedeflediğini duyurdu; API için kapanış tarihi yok.

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

### 6.5 Paddle

- **Taban:** `https://api.paddle.com` (canlı), `https://sandbox-api.paddle.com` (sandbox); ortam anahtarın önekinden seçilir. `Authorization: Bearer`, `Paddle-Version: 1` sabitlenir.
- **Kimlik:** API key, `^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$` (69 karakter). `pdl_sdbx_` anahtarlar test modu olarak etiketlenir. 6 Mayıs 2025'ten önceki "legacy" anahtarlar (50 küçük harf/rakam) izinle sınırlandırılamadığı için reddedilir; Paddle.js client-side token'ları (`live_…`/`test_…`) ayrı mesajla açıklanır. Anahtarlar son kullanma tarihi taşıyabilir (varsayılan 90 gün, en fazla 1 yıl); süresi dolan anahtar yenilenemez, bağlantı hata gösterir ve yeni anahtar yapıştırılır.
- **İzinler (read):** `subscription.read`, `transaction.read`, `adjustment.read` zorunlu; `metrics.read` canlıda zorunlu (sandbox'ta abonelik metrikleri yok). `discount.read` opsiyonel (yalnızca MRR tahmininde kullanılır; yoksa uyarı). `x.write`, `x.read`'i kapsar; anahtarda herhangi bir `.write` izni varsa "salt-okunur anahtar daha güvenli" uyarısı gösterilir.
- **Doğrulama:** Tek istek: `GET /` (izin gerektirmez) → `data.caller.account` (null ise anahtar geçersiz), `data.caller.permissions`, `data.api.environment`. Eksik zorunlu izinlerin hepsi tek mesajda sayılır. Etiket: `caller.account.name` (sandbox'ta "(sandbox)" eki). `GET /account` kullanılmaz: hesap e-postasını döner ve `account.read` ister.
- **Hatalar:** Geçersiz/iptal edilmiş anahtar 401 değil **403 `invalid_token`** döner → `auth`; `forbidden` → eksik izin adıyla `permission`; `paddle_billing_not_enabled` → "Paddle Classic desteklenmez"; `not_available_in_sandbox` (404) → `not_found`.
- **MRR (canlı):** `GET /metrics/monthly-recurring-revenue?from=<bugün−7>&to=<yarın>` → zaman damgası `data.updated_at`'i geçmeyen en yeni nokta (henüz hesaplanmamış günler 0 sayılmaz). Paddle'ın kendi tanımıdır: hesabın bakiye para biriminde (tek para birimi), tek seferlik ödemeler hariç, veri 24 saatte bir yenilenir (en fazla ~1 gün eski). past_due ve vergi muamelesi belgelenmemiştir. Yenilenmiş bir `"0"` noktası MRR 0 demektir; seri boşsa ya da uç nokta 403/404/400 dönerse tahmine düşülür.
- **MRR (tahmin: sandbox, `metrics.read` yok ya da veri yok):** `GET /subscriptions?status=active,past_due&per_page=200` (sayfalı, `after`, `Skip-Count: true`). Her item: `recurring=false`, `status ∈ {trialing, inactive}` ve `billing_cycle=null` olanlar hariç; `price.unit_price.amount × quantity`, `price.billing_cycle {interval, frequency}` ile normalize. Fiyat aboneliğin `currency_code`'unda değilse, o para birimindeki `unit_price_overrides` tek bir tutarda birleşiyorsa o kullanılır; aksi hâlde item hariç tutulur ve loglanır (müşterinin ülkesi adreste, adres okunmaz). İndirim: `subscription.discount` (`type=one-off` ve `ends_at ≤ now` hariç) → `GET /discounts?id=…&status=active,archived` (50'lik gruplar; bulunamayanlar için bir kez `mode=custom`). `recur=false` yok sayılır; `percentage` oranla, `flat` her yenilemede (aylığa normalize, tutarla sınırlı, oransal dağıtılır), `flat_per_seat` adet başına uygulanır; `restrict_to` ürün/fiyat ID'leriyle sınırlar; başka para birimindeki flat indirim uygulanmaz. `discount.read` yoksa MRR indirimsiz hesaplanır ve loglanır. **Sınır:** vergi dahil fiyatlarda (`tax_mode=internal` vb.) liste fiyatı vergiyi içerir; bu yolda "MRR vergi hariç" kuralı tam sağlanamaz. Bütçe biterse hata verilir (kısmi MRR yazılmaz).
- **Aktif abonelik:** Canlıda `GET /subscriptions?status=active,past_due&per_page=1` → `meta.pagination.estimated_total` (100.000'e kadar tam; `-1` gelirse sayfalayarak sayılır). Tahmin yolunda Stripe gibi MRR'ı 0'dan büyük abonelikler sayılır (fiyatlanamayan item'ı olan abonelik de sayılır; ücretsiz, %100 indirimli ve yalnızca deneme item'lı olanlar sayılmaz). Metrik yolu Paddle'ın sayısını kullandığından ücretsiz/%100 indirimli abonelikleri de içerir.
- **Deneme:** `status=trialing` → `estimated_total`.
- **Gelir:** Faz 1: `GET /transactions?status=completed&updated_at[GTE]=<since>&order_by=id[DESC]&per_page=30` (`Skip-Count: true`, `include` yok) → charge: `details.totals.grand_total − grand_total_tax` (kredi uygulanmışsa vergi de orantılı düşer), `fee` = `details.totals.fee`, para birimi `details.totals.currency_code`, tarih = son `captured` ödemenin `captured_at`'i (yoksa `billed_at`). `billed_at` yerine `updated_at` ile süzülür: dunning'de geç tahsil edilen yenileme eski `billed_at`'ini korur ama tamamlanınca `updated_at` güncellenir. `since`'ten önce tahsil edilmiş ya da tutarı ≤ 0 olanlar atlanır. Açıklama: ilk katalog (`standard`) ürünün adı; `custom` ürün adları satışa özel olduğu için kullanılmaz. Faz 2: `GET /adjustments?action=refund,chargeback,chargeback_reverse&status=approved,reversed&per_page=50` (tarih filtresi yok, en yeniden) → `refund`/`chargeback` negatif, `chargeback_reverse` pozitif; tutar `totals.total − totals.tax` (yalnızca vergi iadesi atlanır). İade tarihi `updated_at` (onay anı), chargeback tarihi `created_at` (geri alınınca `updated_at` değişir; `reversed` chargeback ile ayrı gelen geri alma birbirini netler). `credit` sayılmaz (müşteri bakiyesine gider, sonraki işlemin `grand_total`'ını düşürür). `created_at < since − 30 gün` olan kayda ulaşınca durulur. Cursor `{since, phase, after}`; 429'da o ana kadar okunan olaylar ve cursor döner.
- **Limit:** IP başına 240 istek/dk; aşılınca IP 60 sn bloklanır → `rateLimit: 'yield'` (bekleme/yeniden deneme yok). Cloudflare Workers çıkış IP'leri paylaşımlıdır.
  Snapshot en çok 160 istek yapar (gelirin 20 isteğiyle birlikte limitin en çok 3/4'ü); metrik yolu 3 istekle biter, tahmin yolu ~30.000 aboneliğe kadar okur.
- ✅ **Doğrulandı (2026-11-05):** anahtar biçimi ve taban URL'ler ([authentication](https://developer.paddle.com/api-reference/about/authentication)), `GET /` alanları ([api root](https://developer.paddle.com/api-reference/api-root/get-api-root)), izin adları ([permissions](https://developer.paddle.com/api-reference/about/permissions)), hata kodları ([invalid_token](https://developer.paddle.com/errors/shared/invalid_token)), rate limit ([rate limiting](https://developer.paddle.com/api-reference/about/rate-limiting)), sayfalama / `Skip-Count` / `estimated_total` ([pagination](https://developer.paddle.com/api-reference/about/pagination)), MRR uç noktası ([metrics](https://developer.paddle.com/api-reference/metrics/get-metrics-monthly-recurring-revenue)), transaction / adjustment / discount / subscription alanları. **Doğrulanmadı:** metrik MRR'ın past_due ve vergi muamelesi; gelecekteki `to` tarihinin kabulü (400 dönerse tahmine düşülür); `GET /discounts?id=` varsayılanının custom indirimleri döndürüp döndürmediği; chargeback kayıtlarının `status` değeri ve `chargeback_reverse` tutar işareti (mutlak değer alınır).

### 6.6 Polar

- **Taban:** `https://api.polar.sh/v1` (production) ve `https://sandbox-api.polar.sh/v1` (sandbox), `Authorization: Bearer polar_oat_…`. Yollar `/` ile biter.
- **Sürüm:** `Polar-Version: 2026-10` sabitlenir. Polar her çeyrek (Ocak/Nisan/Temmuz/Ekim'in ilk haftası) yeni sürüm çıkarır ve "Deprecated" sürümü kaldırır;
  2026-10 Nisan 2027'nin ilk haftasında kalkar. Kaldırılmış sürüm 404 döner ve "hoomuch'u güncelleyin" hatası gösterilir; sabit sürüm o tarihten önce yükseltilmelidir.
  Bunu bir test zorunlu kılar: `test/providers/polar.test.ts`, sürümün "Deprecated" olduğu ayın 15'inden (2026-10 için 15 Ocak 2027) itibaren sürüm yükseltilene kadar başarısız olur.
- **Kimlik:** Organization Access Token (`polar_oat_…`), tek organizasyona bağlıdır. Token sandbox/production ayrımını göstermez: doğrulama önce production'ı,
  401 alırsa sandbox'ı dener ve sonucu `config.environment`'a yazar; sandbox test modu olarak etiketlenir. Kişisel token (`polar_pat_…`) reddedilir.
- **Gerekli izinler (scope):** `metrics:read`, `subscriptions:read`, `orders:read`, `refunds:read`. Eksik scope 403 `insufficient_scope` döner; hata scope adıyla gösterilir.
- **Doğrulama:** `GET /v1/subscriptions/?limit=1` (ortam tespiti), `GET /v1/metrics/` (bugün), `GET /v1/orders/?limit=1`, `GET /v1/refunds/?limit=1`: 4 istek (sandbox'ta 5).
- **MRR:** `GET /v1/metrics/?start_date=bugün&end_date=bugün&interval=day&timezone=UTC&metrics=monthly_recurring_revenue` → son periyodun değeri (yoksa `totals`).
  Polar'ın panel MRR'ıdır: indirim sonrası, vergi dahil fiyatlarda KDV çıkarılmış net tutar, aylığa normalize; denemeler hariç, `past_due` ve dönem sonu iptaller dahil.
  Polar tutarları settlement para birimine (bugün tüm organizasyonlarda USD) kendi kayıtlı kurlarıyla çevirir → MRR `{USD: …}`. **Fark:** Polar `paused`
  abonelikleri de sayar (net tutarları API'de olmadığından çıkarılamaz). Eksik metrik yanıtı sıfır MRR snapshot'ı **yazmaz**. Abonelik `amount` alanı vergi dahil
  fiyatlarda KDV içerdiği için (Polar'ın varsayılan "location-based" ayarı ABD/Kanada/Hindistan dışında fiyatı vergi dahil yapar) MRR abonelik listesinden hesaplanmaz.
- **Aktif abonelik:** `GET /v1/subscriptions/?status=active&status=past_due&sorting=amount&sorting=started_at&limit=100` → `pagination.total_count` − `amount = 0`
  olanlar. Liste tutara göre sıralı olduğundan yalnızca 0 tutarlı abonelik içeren sayfalar okunur (genelde 1 istek). Stripe'taki gibi ücretsiz, %100 indirimli ve
  yalnızca metered abonelikler sayılmaz. Metrics'teki `active_subscriptions` denemeleri ve 0 tutarlıları da saydığı için kullanılmaz.
- **Deneme:** `GET /v1/subscriptions/?status=trialing&limit=1` → `pagination.total_count`.
- **Gelir:** `GET /v1/orders/?created_after=…&created_before=…&status=paid&status=refunded&status=partially_refunded&sorting=created_at` → charge
  (`net_amount + applied_balance_amount`: indirim sonrası, vergi öncesi, müşteri bakiyesinden ödenen kısım düşülmüş; Polar'ın iade tabanıyla aynı, tam iade sıfırlar),
  `fee` = `platform_fee_amount` (yalnızca sipariş para birimindeyse), açıklama = ürün adı. `GET /v1/refunds/?sorting=-created_at` → `status=succeeded` iadeler
  refund olur (`amount`, vergi öncesi, negatif); yalnızca vergi iadeleri (`amount = 0`) sayılmaz. Para birimi: kaydın kendi para birimi. Polar başarısız yenileme
  siparişini 21 güne kadar yeniden dener (sipariş `pending` kalır) ve iadeler bekleyebilir; bu yüzden her senkronizasyon siparişlerde ve iadelerde 30 gün geriye bakar.
  Sipariş penceresi ilk çağrıda dondurulur (eskiden yeniye; sayfalar kaymaz), iadeler yeniden eskiye okunur ve `total_count` ile sayfa yeniden konumlanır.
  Bütçe bitince ya da 429'da imleç döner.
- **Kişisel veri:** abonelik, sipariş ve iade yanıtları müşteri e-postası, adı ve adresini içerir; yalnızca id, tutar, para birimi, zaman ve ürün adı okunur.
- **Limit:** 500 istek/dk (sandbox 100); 429'da `Retry-After`.
- ✅ **Doğrulandı:** uç noktalar, filtreler, scope adları ve alanlar ([OpenAPI 2026-10](https://polar.sh/docs/openapi/2026-10.openapi.json),
  [API Overview](https://polar.sh/docs/api-reference/2026-10/introduction), [Versioning](https://polar.sh/docs/api-reference/2026-10/versioning),
  [Analytics](https://polar.sh/docs/features/analytics), [Failed payments](https://polar.sh/docs/features/subscriptions/failed-payments)).
  MRR'ın USD'ye çevrildiği ve abonelik `amount`'unun vergi dahil olduğu Polar'ın açık kaynak sunucusundan ([polarsource/polar](https://github.com/polarsource/polar))
  doğrulandı. Canlı API çağrısı yapılmadı.

### 6.7 Dodo Payments

- **Taban:** `https://live.dodopayments.com` (canlı) ve `https://test.dodopayments.com` (test), `Authorization: Bearer`.
  Liste uçları `page_number` (0'dan) + `page_size` (en çok 100) ile sayfalanır, yalnızca `{items}` döner; kısa sayfa son sayfadır.
- **Kimlik:** Kaynak bazında None/Read/Write izinli API anahtarı. `dodo_live_…` / `dodo_test_…` öneki modu belirler. Önekten
  önceki eski anahtarlarda önce canlı, 401 gelirse test sunucusu denenir; mod `config.testMode`'a yazılır ve bu anahtarlar yazma
  yetkili olabileceği için uyarı gösterilir. IP allowlist'li anahtarlar çalışmaz (Workers'ın sabit IP'si yok).
- **Gerekli izinler (read):** Subscriptions, Balances.
- **Doğrulama:** `GET /subscriptions?page_size=1` + `GET /balances/ledger?page_size=1` (eski anahtarda en çok 3 istek).
  403 `INSUFFICIENT_PERMISSION` mesajındaki kapsam (ör. `balances:read`) gösterilir; `IP_ADDRESS_NOT_ALLOWED` ve
  `MERCHANT_NOT_LIVE` (canlı ödemeleri açılmamış işletme) için ayrı mesaj.
- **MRR:** `GET /subscriptions?status=active` ve `status=past_due` (`page_size=100`). `recurring_pre_tax_amount` (minor unit,
  vergi öncesi, ödeme başına; `quantity` ile çarpılmaz) `payment_frequency_interval/count` ile normalize edilir
  (`subscription_period_*` vadedir, fatura sıklığı değil). `past_due` (işletmenin açtığı grace period: müşteri erişimi sürer,
  yeniden denemeler devam eder) dahil; `on_hold` (yenileme durdu, erişim kesildi), `paused`, `pending`, `cancelled`, `failed`,
  `expired` hariç. `cancel_at_next_billing_date=true` olan aktif abonelik dönem sonuna kadar sayılır. Tutarı 0 olanlar
  (salt kullanım bazlı, %100 indirim) ve `on_demand` abonelikler MRR'a ve aktif sayıya girmez. `tax_inclusive=true` tutarlar
  vergi dahildir ve olduğu gibi sayılır (API oran vermez; log'lanır). Para birimi: `subscription.currency`.
  Snapshot en çok 160 istek yapar (bkz. Limit), yani ~16.000 aboneliğe kadar okunur.
- **Deneme:** `trialing` durumu yoktur. `trial_period_days > 0` ve `next_billing_date ≤ created_at + trial_period_days (+1 saat)`
  → deneme (ücretli deneme dahil; belgelerin önerdiği kontrol). `next_billing_date` ileri alınarak uzatılan deneme ücretli sayılır.
- **Gelir:** `revenueHistory = 'daily'`. Ödeme listesinde vergi yoktur (yalnızca `GET /payments/{id}`), bu yüzden kaynak bakiye
  defteridir: `GET /balances/ledger?created_at_gte=…&created_at_lte=…`, `since`'in UTC gece yarısından itibaren 7 günlük
  dilimlerle yeniden eskiye. Dilim tamamen okununca günleri yazılır; cursor dilimin ara toplamlarını taşır; 429'da çağrı
  cursor'la biter. Gün × cüzdan para birimi (USD/EUR/GBP): `gross = payment − tax`,
  `refunds = refund − refund_reversal + dispute − dispute_reversal − tax_reversal`; negatif kalan taraf diğerine aktarılır
  (`gross − refunds` değişmez). Açık/kaybedilen itirazlar iade sayılır, kazanılanın reversal'ı bunu geri alır. Komisyonlar,
  payout, Dodo kredileri, düzeltmeler, kur farkı ve rezervler hariç. Hareketsiz okunan günler 0 USD yazılır. Transactions
  sayfasında satır yoktur.
- **Limit:** İşletme başına (tüm anahtarlar ortak) 40 istek/sn, 240 istek/dk; 429'da `Retry-After` yok. Snapshot en çok 160 istek
  yapar (gelirin 20 isteğiyle birlikte limitin en çok 3/4'ü), satıcının kendi entegrasyonuna pay kalır.
- ✅ **Doğrulandı:** hostlar, önekler, izin hataları ([API reference](https://docs.dodopayments.com/api-reference/introduction),
  [error codes](https://docs.dodopayments.com/api-reference/error-codes)); abonelik alanları ve durumları
  ([list subscriptions](https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions-1),
  [subscriptions](https://docs.dodopayments.com/features/subscription)); ödeme listesinde vergi olmadığı
  ([list payments](https://docs.dodopayments.com/api-reference/payments/get-payments)); defter olay türleri ve yönleri
  ([ledger](https://docs.dodopayments.com/api-reference/balance-ledger/list-ledger-entries),
  [balances](https://docs.dodopayments.com/features/account-summary-payout-wallet), [reports](https://docs.dodopayments.com/features/reports)).
- ⚠️ **Doğrulanmadı:** defter `amount` biriminin minor unit olduğu; izin adının "Balances" olduğu; test modunda defterin dolu
  olduğu; `recurring_pre_tax_amount`'un eklenti/indirim içerdiği; sayfalama sırasının kararlılığı.

### 6.8 Chargebee

- **Taban:** `https://{site}.chargebee.com/api/v2`, HTTP Basic (kullanıcı adı = API anahtarı, parola boş). API v2, Product Catalog 2.0.
  `site` alanı tek bir DNS etiketine indirgenir (`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`; yapıştırılan `https://acme.chargebee.com/…` → `acme`),
  böylece anahtar başka bir hosta gidemez. `-test` ile biten site test modu olarak etiketlenir.
- **Kimlik:** Read-Only Key: "All" ya da "Restricted" + "Allow read-only access to transactional data". Yalnızca GET yaptığımız için
  tam yetkili bir anahtar ayırt edilemez; form salt-okunur anahtar ister.
- **Doğrulama:** `GET /subscriptions?limit=1` + `GET /transactions?limit=1`. 401 → apiKey; 403 `api_authorization_failed` → apiKey
  (eksik izin adıyla); 404 `site_not_found` (ya da yönlendirme) → site alanı. Etiket: `Chargebee: acme (test)`.
- **MRR:** `GET /subscriptions?status[in]=["active","non_renewing"]` (sayfalı, `limit=100`, `offset` = önceki `next_offset`) →
  Chargebee'nin kendi `subscription.mrr` değeri toplanır (abonelik para birimi; vergi, kurulum ücreti ve tek seferlik ücretler hariç;
  indirimler sitenin MRR ayarlarına göre). Böylece rakam satıcının Chargebee panelindekiyle aynıdır. `mrr` alanı hiç yoksa kalemlerden
  hesaplanır: `plan` + `addon` kalemlerinin `amount` değeri, kalemin (multi-frequency) ya da aboneliğin `billing_period(_unit)` değeriyle
  normalize edilir; `charge` kalemleri ve kalem denemesindekiler hariç, indirimler uygulanmaz. Chargebee'de past_due yoktur: dunning'deki
  abonelik `active` kalır ve sayılır. `mrr = 0` olanlar ($0 plan, %100 indirim) ne MRR'a ne aktif aboneliğe girer. Liste sonuçları
  eventually consistent olduğundan nesnenin kendi `status` değeri filtreye üstün gelir.
- **Deneme:** `status[is]=in_trial` sayısı (API toplam vermez, sayfa sayfa sayılır).
- **Gelir:** Chargebee merchant of record değildir: tahsil edildiği haliyle (vergi dahil, işlem para biriminde, gateway komisyonu yok —
  API vermez). `GET /transactions?type[in]=["payment","refund","payment_reversal"]&updated_at[between]=[from,to]&date[after]=from−30 gün&sort_by[asc]=updated_at`
  (Chargebee'nin önerdiği artımlı senkron). `payment` + `success` → charge; `refund` / `payment_reversal` + `success` → refund (negatif);
  `payment` + `late_failure` → charge + `<txn>:late_failure` refund (`updated_at` anında). `in_progress`, `failure`, `voided`,
  `needs_attention`, `timeout` ve `authorization` hariç. Kredi notları okunmaz (iade her zaman bir refund transaction'ıdır, çift sayım yok).
  `date` yerine `updated_at` ile süzmek, 2–7 günde netleşen direct debit'leri ve geç başarısızlıkları yakalar. Pencere cursor'da donar;
  429'da okunanlar korunur ve cursor döner.
- **Para birimi:** Tutarlar "in cents" (ana birimin 1/100'ü); sıfır ondalıklı para birimleri (CLP, ISK, JPY, KRW, MGA, PYG, VND, XAF, XOF,
  XPF) ana birimdedir. Hepsi hoomuch'un ISO 4217 minor unit'ine (`currencyExponent`) çevrilir: HUF, IDR gibi iki ondalıklılar olduğu gibi kalır; MGA (ISO 2) ×100.
- **Limit:** Test siteleri ve Starter 150 istek/dk (Performance 1000, Enterprise 3500), satıcının kendi entegrasyonuyla paylaşılır.
  Snapshot 429'da kısa Retry-After'ı bekler; gelir hemen bırakır ve sonraki senkronda devam eder. Plan API'den okunamadığı için
  snapshot her sitede en çok 90 istek yapar (gelirin 20 isteğiyle birlikte 150'nin en çok 3/4'ü), yani ~9.000 abonelik ve deneme.
- ✅ **Doğrulandı:** filtreler, operatörler ve sayfalama ([list subscriptions](https://apidocs.chargebee.com/docs/api/subscriptions/list-subscriptions),
  [list transactions](https://apidocs.chargebee.com/docs/api/transactions/list-transactions), [list operations](https://apidocs.chargebee.com/docs/api/list-ops));
  `mrr` ve statüler ([subscription object](https://apidocs.chargebee.com/docs/api/subscriptions/subscription-object)); hata kodları ve
  limitler ([error handling](https://apidocs.chargebee.com/docs/api/error-handling)); birimler ([currencies](https://apidocs.chargebee.com/docs/api/currencies),
  [supported currencies](https://www.chargebee.com/docs/2.0/supported-currencies.html)); MRR tanımı
  ([monthly recurring revenue](https://www.chargebee.com/docs/billing/2.0/reports-and-analytics/monthly-recurring-revenue));
  geç başarısızlık davranışı ([late payment failures](https://www.chargebee.com/docs/payments/2.0/kb/billing/handling-chargebacks-and-late-payment-failures-in-chargebee)).
- ⚠️ **Doğrulanmadı:** `updated_at[between]` + `date[after]` + `sort_by[asc]=updated_at` birleşimi canlı denenmedi (filtreler tek tek belgeli).

### 6.9 Creem

- **Durum:** v1'de **desteklenmiyor**; sağlayıcı listesinde yok. Belgeler doğru bir gelir hesabına yetmiyor:
  - `GET /v1/transactions/search` yalnızca `customer_id`, `order_id`, `product_id`, `page_number`, `page_size` alır; tarih ve
    durum filtresi yok (açıklama "date range, and status" dese de parametre tanımlı değil), sıralama belgelenmemiş.
  - İadeler tarihlenemiyor: işlemde yalnızca `status` (`refunded`, `partialRefund`, `chargedBack`) ve `refunded_amount` var,
    `refunded_at`/`updated_at` yok; iade listeleme ucu yok (yalnızca `POST /v1/refunds`); tarih yalnızca `refund.created` webhook'unda.
  - `GET /v1/stats/summary?interval=day` günlük `grossRevenue`/`netRevenue` verir; net "komisyon ve vergi sonrası" (SPEC §6
    komisyonu düşmez), brütün vergi/iade içeriği belgelenmemiş, para birimi yalnızca EUR/USD.
- **Bilinenler:** `x-api-key`; `https://api.creem.io` / `https://test-api.creem.io`; geçersiz anahtar 403 döner; tahsilat
  `amount_paid − tax_amount` (cent), `created_at` ms; abonelik durumları `active`, `trialing`, `past_due`, `scheduled_cancel`,
  `unpaid`, `paused`, `canceled`; anahtarlar kısıtlanamaz (tam yetki).
- **Açmak için:** işlemlerde tarih filtresi + belgelenmiş sıralama, ya da tarihli iade listesi; ya da `stats/summary` için
  vergi hariç, komisyon dahil gelir tanımı.

### 6.10 Gumroad

- **Taban:** `https://api.gumroad.com/v2`, `Authorization: Bearer <access token>` (dokümandaki `access_token=` parametresi yerine başlık; token URL'ye ve loglara girmez).
- **Kimlik:** Settings → Advanced → Applications'ta oluşturulan uygulamada "Generate access token" ile üretilen token. Bu formdan oluşturulan uygulama tüm public scope'ları alır (`account`, `edit_products`, `edit_sales` = iade, `view_sales`, …) ve token bunları taşır; daraltılamaz → **tam yetkili**, UI'da uyarı gösterilir. Token iptal edilene kadar geçerlidir. Gereken scope: `view_sales`.
- **Doğrulama:** `GET /v2/user` (etiket: satıcının adı, yoksa profil URL'si) + `GET /v2/sales?after=<bugün>` (`view_sales` kontrolü). 401 → geçersiz token, 403 → eksik scope (gövde boş). Sandbox yok (`testMode=false`); test satın alımları ve test abonelikleri API'de listelenmez.
- **Para:** Satıştaki tüm tutarlar **kanonik USD cent**'tir; `currency` yalnızca listeleme para birimidir. `price`, Gumroad'un merchant of record olarak tahsil ettiği vergiyi **içermez** (alıcıya üstüne eklenir). `tax_included_in_price=true` ise (eski, satıcının topladığı dahil vergi) `tax_cents` düşülür.
- **MRR:** `GET /v2/products` (sayfalı) → üyelik ürünleri (`is_tiered_membership` ya da eski `subscription_duration`'lı abonelik) → her biri için `GET /v2/products/{id}/subscribers?paginated=true` (yalnızca aktif abonelikler, 100/sayfa). Abone nesnesinde **fiyat yoktur**; her ücretli abone **son tahsilatının** tutarıyla (USD) fiyatlanır: önce ürünün son 35 günlük satışları (`GET /v2/sales?product_id=…&after=…`, istek başına 10 satış; aylık yenilemeleri kapsar), bulunamayanlar için `GET /v2/sales/{son purchase_id}`. Son tahsilat upgrade proration'ı, $0 ya da başka periyottaysa veya bütçe yetmezse kademenin liste fiyatı kullanılır (`recurrence_prices.<recurrence>.price_cents`, ürün para birimi, indirimsiz); kademe bilinmiyor ve fiyatlar farklıysa en ucuz kademe (alt sınır) alınır ve loglanır. Liste fiyatı belirsiz aboneler önce sorgulanır. Normalize: `monthly ×1`, `quarterly ÷3`, `biannually ÷6`, `yearly ÷12`, `every_two_years ÷24`. Ürün/abone listeleri bütçeye sığmazsa snapshot yazılmaz.
- **Aktif abonelik:** `alive`, `pending_cancellation` (dönem sonuna kadar), `pending_failure` (yenileme yeniden deneniyor; past_due gibi) ve `payment_method_update_required` durumundaki, tutarı > 0 olan aboneler. Ücretsiz kademeler ve `cancelled_at`/`ended_at`/`failed_at`'i geçmişte olanlar sayılmaz.
- **Deneme:** `free_trial_ends_at > now` olan aboneler.
- **Gelir:** `GET /v2/sales?after=<gün>` en yeniden eskiye, `page_key` ile (sabit 10 satış/sayfa, devam ettirilebilir cursor). `price > 0` her satış → charge (USD, `fee = gumroad_fee`, açıklama = ürün adı). `refunded`/`chargedback` → tam iade; `partially_refunded` → `price − amount_refundable_in_currency` (yalnızca USD listelemede; diğerlerinde atlanır ve loglanır). **API'de iade tarihi yok:** iade, ait olduğu satışın gününe yazılır (`<sale id>:refund`); satış günü bazında net doğrudur. Artımlı senkronizasyonlar geç iadeler için 30 gün geriye bakar; ilk backfill (pencere > 45 gün) bakmaz. $0 satışlar (ücretsiz ürün, deneme kaydı, paket kalemi) ve hediye kopyaları atlanır.
- **Limit:** Okuma uçları için belgelenmiş limit yok; gelir 429'da cursor döndürür, snapshot kısa Retry-After'ı bekler.
- ⚠️ **Yaklaşık:** MRR tam hesaplanamaz, çünkü abonenin ödediği tutar API'de yok. Son tahsilat tek seferlik indirimi, ilk tahsilattaki bahşişi veya bekleyen fiyat değişikliğini taşıyabilir; liste fiyatı yedeği indirim/PPP/PWYW/adet'i görmez. `purchase_ids` sırası belgelenmemiştir (son eleman en yeni kabul edilir).
- ✅ **Doğrulandı:** uç noktalar, alanlar, abone durumları ([API](https://gumroad.com/api)); USD/vergi anlamı, sayfa boyutları, varsayılan scope'lar ve aktif abone filtresi açık kaynak koddan ([antiwork/gumroad](https://github.com/antiwork/gumroad)).

### 6.11 Adapty

- **Taban:** `POST https://api-admin.adapty.io/api/v1/client-api/metrics/analytics/` (Export Analytics API, "Retrieve analytics data"),
  `Authorization: Api-Key secret_live_…`, `Adapty-Tz: UTC`. Belgelenmiş salt-okunur bir dışa aktarma uç noktasıdır; sorgu JSON gövdesinde
  gider (`readQuery`). İstek başına tek grafik: `chart_id`, `filters.date: [başlangıç, bitiş]`, `period_unit: day`, `date_type: purchase_date`.
- **Kimlik:** Uygulamaya özel Secret API key (`secret_live_…`, App settings → General). Salt-okunur anahtar yoktur: aynı anahtar sunucu
  API'sini (profil, erişim seviyesi, paywall) de açar, formda uyarı gösterilir. Public SDK key (`public_live_…`) ağ çağrısı yapılmadan
  reddedilir. Her Adapty uygulaması ayrı bağlantıdır. Limit: uygulama başına saniyede 2 istek (anahtarlar paylaşır); 429'da Retry-After yok.
- **Doğrulama:** `mrr` + `revenue` (bugün). Gelir grafiği okunamazsa bağlantı kurulur, uyarı gösterilir (`revenueHistory='none'`).
- **Snapshot:** bugün için `mrr` (brüt `revenue` metriği), `subscriptions_active`, `trials_active` + son 30 günün `revenue` toplamı (`value`).
  MRR veya aktif abonelik okunamazsa snapshot **yazılmaz**; deneme ve 30 günlük gelir okunamazsa `null`. Adapty'nin tanımları aynen
  kullanılır: MRR denemeleri ve tek seferlik satın almaları içermez; aktif abonelik denemeleri **ve yenilemesi kapatılmış** abonelikleri
  hariç tutar (§6'dan farklı).
- **Snapshot geçmişi (v1.1):** bağlantının henüz snapshot'ı yokken (§4.1) `fetchSnapshotHistory`, `mrr`, `subscriptions_active`
  ve `trials_active` grafiklerini dünden geriye en çok 90 gün için birer istekle okur (3 istek); MRR trendi tek noktayla değil
  geçmişle başlar. "Dün", sahibin yerel bugününden (engine'in geçirdiği `today`) önceki gündür; UTC'nin önündeki sahipte bu,
  Adapty'nin henüz bitmemiş UTC bugünüdür ve o anki seviyesiyle okunur. Bu grafikler `last` ile toplanır: günlük seri ancak son
  günün değeri belgelenmiş `value_to` (yoksa `value`) ile tutarsa ve hiçbir gün iki kez geçmiyorsa kullanılır; son günü boşsa ya
  da karşılaştırılacak değer yoksa kullanılmaz (gün gün yedek sorgu yok). MRR'ı ya da aktif abonelik sayısı olmayan gün (`null` nokta,
  uygulamanın ilk aboneliğinden önceki günler) atlanır, sıfırla doldurulmaz. Deneme grafiği okunamazsa, reddedilirse ya da
  429'da kalırsa o günlerin denemesi `null`. Bütçe MRR ve abonelik grafiklerine yetmiyorsa istek yapılmaz; süre ikisinin arasında
  dolarsa da geçmiş boş döner. Zorunlu grafik reddedilirse çağrı hata verir: engine loglar, senkronizasyon yine başarılı olur.
- **Gelir geçmişi:** ≤ 92 günlük pencerelerde günlük `revenue` ve `refund_money` → `daily_revenue` (`source='provider'`, USD).
  Adapty Revenue = kullanıcının ödediği brüt tutar (mağaza komisyonu düşülmeden, vergi dahil; RevenueCat Revenue grafiğiyle aynı) −
  işlendiği gün düşülen iadeler. Gün başına `gross = revenue + refund_money`, `refunds = refund_money`, `count = 0` (Adapty günlük işlem
  sayısı vermez). Günlük seri ancak günlerin toplamı belgelenmiş `value` ile tutarsa kullanılır; tutmazsa aynı iki grafik gün gün
  sorgulanıp `value` okunur (günde 2 istek, imleçle devam). Gelir grafiği hiç kullanılamazsa snapshot'taki 30 günlük gelir gösterilir.
- **Para birimi / gün / test modu:** Tüm parasal grafikler USD (işlem anındaki kurla). Günler `Adapty-Tz: UTC` ile UTC'dir.
  Sandbox satın almaları Adapty grafiklerine hiç girmez, bu yüzden test modu yoktur.
- ✅ **Doğrulandı:** uç nokta, kimlik başlığı, `chart_id` listesi, `revenue`/`proceeds`/`net_revenue` metrikleri, USD, sandbox hariç,
  2 istek/sn ([export API](https://adapty.io/docs/api-export-analytics/operations/retrieveAnalyticsData),
  [revenue](https://adapty.io/docs/revenue), [refund money](https://adapty.io/docs/refund-money)). İç `data` dizisindeki günlük nokta
  şekli belgelenmemiştir (`{type:'total', values:[{x, y}]}` varsayılır); toplamla doğrulanır, tutmazsa gün gün `value` okunur.
  Aralık sorgusunda `mrr` ve aktif sayıların serisi ile `value_to`'nun aralık sonundaki seviye olduğu da varsayımdır (geçmiş
  bununla doğrulanır).

### 6.12 Superwall

- **Taban:** `https://api.superwall.com`, `Authorization: Bearer sk_…` (organization API key) + Organization ID
  (dashboard adresindeki `app.superwall.com/{organization_id}/…` sayısı).
- **İzinler:** `charts:read` (zorunlu: MRR, aktif abonelik), `data:read` (opsiyonel: günlük gelir/iade ve aktif
  deneme). Proje erişimi "All projects" önerilir; kısıtlı anahtarda doğrulama uyarı verir.
- **Doğrulama:** `GET /v2/charts/definitions?organization_id=` + MRR grafiği + bugünün gelir sorgusu (`data:read`
  yoklaması). `data:read` yoksa bağlantı uyarıyla kurulur, `revenueHistory='none'` yazılır.
- **Snapshot:** grafik anahtarları sabit yazılmaz; `definitions.chart_types` içinden "MRR" ve "Active Subscriptions"
  adıyla bulunur. `POST /v2/charts/data` (salt okunur sorgu uç noktası, `readQuery`) → `breakdown: null`, son 7 gün, günlük,
  `environment: PRODUCTION`, organizasyon geneli. Değer son gün noktasıdır; bugünün noktası boşsa ya da dün >0 iken
  0 görünüyorsa son tamamlanmış gün kullanılır (sahte sıfır yazılmaz); negatif MRR, Adapty'deki gibi 0 sayılır.
  Aktif abonelik = "unexpired, paid" (deneme hariç). **Aktif deneme** Superwall metriği değildir: `data:read` ile
  SQL'den türetilir (son olayı TRIAL dönemi, `expiration` değil, bitişi gelecekte olan abonelik; iptal edilmiş deneme
  bitene kadar sayılır). Entegrasyon olayı hiç yoksa `null`. Para birimi USD.
- **Snapshot geçmişi (v1.1):** bağlantının henüz snapshot'ı yokken (§4.1) aynı iki grafik belgelenmiş `last_90_days` hazır aralığıyla okunur
  (definitions + 2 istek). Aralık Superwall'un (UTC) bugünüyle biter, istekte saat dilimi yoktur; günler sahibin yerel
  bugününden geriye sayılır, dünden geriye en çok 89 gün gelir; bugünün snapshot'ıyla dashboard'un 90 günlük penceresi dolar.
  UTC'nin önündeki sahipte dün Superwall'un bitmemiş bugünüdür: snapshot gibi okunur. Değeri olmayan (`y: null` dahil) ya da
  hâlâ `incomplete` işaretli geçmiş noktalar ve iki grafikten yalnızca birinde olan günler atlanır, sıfırla doldurulmaz. Geçmiş
  günlerin denemesi `null`: Superwall'da deneme serisi yok, SQL yalnızca bugünü verir. Bütçe üç isteğe yetmiyorsa istek
  yapılmaz; süre grafikler arasında dolarsa da geçmiş boş döner. Reddedilen (400), birimi beklenmeyen ya da bir günü iki kez
  veren grafik çağrıyı hata ile bitirir: engine loglar, senkronizasyon yine başarılı olur.
- **Gelir geçmişi:** `GET /v2/organizations/{id}/query?query=…` (ClickHouse, salt okunur; ham SQL gövdeli POST yerine
  belgelenmiş GET kullanılır) ile `open_revenue.attributed_events_by_ts_rep FINAL` üzerinde gün bazında toplanır →
  `daily_revenue` (`source='provider'`, USD). Brüt = pozitif `price` toplamı, iade = negatif `price` toplamının mutlak
  değeri (iade günü). `price` Superwall'un "Sales" tabanıdır: **KDV ve mağaza komisyonu dahil** (RevenueCat ve Adapty
  ile aynı). Aynı mağaza işlemi (mağaza + RevenueCat + SDK kopyaları) `transactionId` ile bir kez sayılır; sandbox,
  Family Sharing ve RevenueCat'in Stripe kopyaları hariç. SQL sabit tek bir SELECT'tir; tarihler `param_*` ile geçer;
  yalnızca toplamlar döner (kullanıcı verisi çekilmez). 31 günlük pencereler, cursor ile devam; 429'da cursor döner.
- ⚠️ **Doğrulanmadı:** grafik adları/anahtarları ve nokta anlamı canlı denenmedi; grafik değerlerinin USD olduğu
  varsayımdır (yanıtta para birimi yok). `last_90_days` OpenAPI'de belgelidir; bugünü içerdiği (7 günlük aralık gibi)
  canlı denenmedi. Tablo şeması Superwall'un resmî ajan becerisinden
  ([superwall/skills](https://github.com/superwall/skills)) alındı. Uygulamanın "revenue provider" seçimi API'de yok;
  mağaza ile RevenueCat aynı `transactionId`'yi taşımıyorsa çift sayım olabilir. Test modu yok (sandbox hariç tutulur).

### 6.13 App Store Connect

- **Taban:** `GET https://api.appstoreconnect.apple.com/v1/salesReports` (Sales and Trends). Yanıt gzip'li, sekmeyle
  ayrılmış metindir (`application/a-gzip`); o gün için rapor yoksa 404 döner. JSON değil, bu yüzden `fetchBytes` ile
  indirilir, akış hâlinde açılıp satır satır okunur (`src/providers/reports.ts`).
- **Kimlik:** Her istek ES256 imzalı bir JWT taşır: başlıkta `kid` (Key ID), gövdede `iss` (Issuer ID), `iat`, `exp`
  (en çok 20 dk; hoomuch 10 dk kullanır), `aud: appstoreconnect-v1`. Token, kullanıcının yapıştırdığı **team** API
  anahtarının `.p8` dosyasıyla WebCrypto'da imzalanır; `.p8` şifreli saklanır, Issuer ID / Key ID / vendor number
  düz config'tedir. Individual key'ler Sales and Finance'e erişemediği için kabul edilmez. Rol: **Sales** (Finance ya da
  Admin de çalışır ama daha fazlasını yapabilir); Apple'da yalnızca rapor okuyan anahtar yoktur, formda uyarı gösterilir.
  Limit: anahtar başına saatlik kayan kota (`X-Rate-Limit`), aşılınca 429.
- **Doğrulama:** iki gün önceki `SALES / SUMMARY / DAILY` raporu (1 istek). 200 ya da 404 anahtarın, rolün ve vendor
  number'ın kabul edildiğini gösterir; 404'te "o gün satış yoksa normal" notu çıkar. 401 → anahtar alanı, 403 → rol,
  vendor geçen 400/403 → vendor number alanı.
- **Snapshot:** `SUBSCRIPTION / SUMMARY / DAILY / 1_3` raporu; dünden geriye 4 güne kadar ilk yayımlanmış gün kullanılır.
  Hiçbirinde rapor yoksa abonelik yok sayılır (Apple, aktif abonelik oldukça her gün rapor yayımlar). **MRR** = standart
  fiyatlı aboneliklerin (`Active Standard Price Subscriptions`) `Customer Price` × adet, `Standard Subscription Duration`
  ile aylığa normalize (7 gün → hafta). **Aktif abonelik** = standart + ücretli teklifteki (introductory, promotional,
  offer code, win-back; pay up front ve pay as you go) abonelikler; bunlar MRR'a **girmez**, çünkü rapor dönem başına ne
  ödediklerini söylemez. **Aktif deneme** = free trial sütunlarının toplamı. Billing retry ve grace period sayılmaz.
  `mrrByProduct` abonelik adına göre bölünür.
- **Gelir geçmişi:** günde bir `SALES / SUMMARY / DAILY` raporu (`filter[version]` gönderilmez; Apple güncel sürümü
  verir, sabitlenen sürüm geçmişte reddedildi) → `daily_revenue` (`source='provider'`), müşteri para birimi başına bir
  nokta. Tutar `|Units| × |Customer Price|`; `Units` ya da fiyat negatifse iade. Fiyatı 0 olan satırlar (ücretsiz
  indirme, güncelleme) ve 0 adetli kısmi iade satırları atlanır; `count` = ücretli birim sayısı. Her senkron son 3 günü
  yeniden okur (rapor ertesi sabah, PT, yayımlanır); 404 günü boş geçilir. Geçmiş en çok 364 gün (Apple günlük raporları
  bir yıl tutar). Bütçe ya da 429 bitince gün imleci döner.
- **Para birimi / gün / test modu:** Tutar müşterinin ödediği fiyattır (vergi dahil, Apple komisyonu düşülmeden),
  müşterinin para biriminde; RevenueCat, Adapty ve Superwall ile aynı taban. Günler Apple'ın Pacific Time günleridir,
  UTC gün anahtarına aynen yazılır. Sandbox satın almaları Sales and Trends'e girmez: test modu yok.
- **Kişisel veri:** Abonelik raporundaki `State` (müşterinin serbest metin eyaleti) ve ülke okunmaz, saklanmaz.
- ✅ **Doğrulandı:** uç nokta, filtre değerleri ve rapor türü/sürüm tablosu, JWT alanları ve 20 dk sınırı, individual
  key kısıtı, rapor sütunları (Summary Sales, Subscription 1_3), yayımlanma zamanı ve bir yıllık saklama
  ([salesReports](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports),
  [tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests),
  [subscription report](https://developer.apple.com/help/app-store-connect/reference/reporting/subscription-report),
  [availability](https://developer.apple.com/help/app-store-connect/reference/reporting/sales-and-trends-reports-availability)).
  ⚠️ **Doğrulanmadı:** canlı denenmedi. Hangi rollerin raporu API'den indirebildiği Apple'ın rol tablosundan çıkarıldı
  (Sales ve Finance Sales and Trends'i görür); hatalı vendor number'ın 400 mü 403 mü döndüğü belgelenmemiştir (ikisi de
  vendor alanına eşlenir). İade satırlarında `Customer Price`'ın işareti belgede iki yerde farklı anlatılır: ikisi de
  iade sayılır. Hata gövdeleri Apple'ın `ErrorResponse` şeklindeki örnek değerlerdir.

### 6.14 Google Play

- **Taban:** Google Play'in gelir API'si yoktur. Play Console raporları geliştirici hesabına ait özel bir Cloud Storage
  bucket'ına (`gs://pubsite_prod_rev_…`) aktarır; hoomuch onları Cloud Storage JSON API ile okur:
  `GET https://storage.googleapis.com/storage/v1/b/{bucket}/o` (liste) ve `…/o/{nesne}?alt=media` (indirme).
  Taban planların fatura dönemi ve fiyatı Android Publisher API'den gelir:
  `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{paket}/subscriptions`.
- **Kimlik:** Kullanıcı bir service account oluşturur, JSON anahtarını yapıştırır (şifreli saklanır) ve service
  account'u Play Console'da **View app information and download bulk reports** ve **View financial data** izinleriyle
  davet eder. hoomuch RS256 imzalı bir JWT assertion'ı `https://oauth2.googleapis.com/token`'a form POST'uyla verir
  (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `tokenForm`) ve bir saatlik access token alır; token
  saklanmaz, loglanmaz. JSON'daki `token_uri` yok sayılır, assertion yalnızca Google'a gider. Scope: bucket için
  `devstorage.read_only`; snapshot'ın katalog okuması için `androidpublisher` (salt-okunur türü yoktur; yetkiyi Play
  Console izinleri sınırlar). Google Play Android Developer API, service account'un projesinde açık olmalıdır.
  Yeni verilen erişimin bucket'a yansıması bir güne kadar sürebilir.
- **Doğrulama:** token + `sales/` listesi (finansal izin) + `financial-stats/subscriptions/` listesi + bir istatistik
  dosyası + o uygulamanın kataloğu (≈ 5 istek). Bucket 403 → service account e-postası ve gereken izinlerle mesaj
  (Google yanlış bucket'ta da 403 verir), Publisher 403 → API kapalı ya da uygulama izni yok. İstatistik yoksa
  "MRR birkaç gün 0 görünür" notuyla bağlanır.
- **Snapshot:** bu ayın (ayın başında geçen ayın) `financial-stats/subscriptions/subscriptions_*_YYYYMM_country.csv`
  dosyaları (`matchGlob`); her dosyanın en yeni günü, en yeni günden 3 günden fazla geride kalan dosya bayat sayılıp
  atlanır. **Aktif abonelik** = Google'ın `Active Subscriptions` toplamı. **MRR** = her satır × taban planın o ülkedeki
  güncel fiyatı (`regionalConfigs`), `billingPeriodDuration` ile aylığa normalize (installments dahil). Prepaid planlar
  aktif sayılır ama MRR'a girmez; fiyatı bulunmayan ülke/plan satırları aktif sayılır, MRR'a girmez (logda `unpriced`).
  Google hangi abonenin denemede ya da teklif fiyatında olduğunu söylemediği için **aktif deneme `null`**'dır ve bu
  aboneler taban plan fiyatından sayılır; eski fiyattaki (grandfathered) aboneler bugünkü fiyattan sayılır (§6'dan
  farklı). Veri Google'ın aktarımına göre birkaç gün geridedir. `mrrByProduct` aboneliğin listing başlığına göre
  (en-US, yoksa ilk dil) bölünür.
- **Gelir geçmişi:** `sales/salesreport_YYYYMM.zip` (estimated sales; zip içinde tek CSV, sipariş başına satır) →
  `transactions`. `Financial Status` "Charged" → charge; "Refund", "Partial refund" (ve chargeback) → negatif refund;
  diğerleri (ör. iptal) atlanır. Tutar `Charged Amount` (alıcının ödediği, vergi dahil, Google komisyonu düşülmeden),
  `Currency of Sale` biriminde; zaman `Order Charged Timestamp`. `externalId` = sipariş no + tür + saniye (aynı saniyede
  ikinci satır `:1`). Açıklama SKU ID (+ taban plan). `since`'ten bu aya kadar her ay bir dosya; 404 ayı boş. Bir sayfa
  en çok 5.000 olay taşır; dolarsa imleç `{ay, son (zaman, id)}` olur ve sonraki senkron aynı dosyayı yeniden okuyup
  oradan devam eder (satır sırasına bağlı değildir).
- **Dosya biçimi:** İstatistik CSV'leri genellikle BOM'lu UTF-16'dır; kodlama BOM'dan (yoksa NUL desenden) anlaşılır,
  UTF-16 elle çözülür. Zip merkezi dizinden okunur (ZIP64 ve şifreli arşivler reddedilir), açılan veri 512 MB'ta kesilir.
  İndirilen dosya en çok 32 MB'tır (`MAX_REPORT_BYTES`).
- **Kişisel veri:** Satış raporundaki alıcı şehri, eyaleti, posta kodu, ülkesi ve cihaz modeli okunmaz; olaylara ve
  loglara girmez (testle denetlenir).
- **Test modu:** Lisans test kullanıcılarının satın almaları finansal raporlara girmez: test modu yok.
- ✅ **Doğrulandı:** dosya yolları ve adları, satış raporu ve abonelik istatistiği sütunları, UTF-16 notu, service account
  akışı ve izin adları ([Play Console raporları](https://support.google.com/googleplay/android-developer/answer/6135870)),
  JWT bearer akışı ve hata kodları ([service account](https://developers.google.com/identity/protocols/oauth2/service-account)),
  `monetization.subscriptions.list`, `BasePlan`, `RegionalBasePlanConfig`, `Money` şemaları ve Cloud Storage
  `objects.list` (`matchGlob`) / `objects.get` (`alt=media`) parametreleri (iki API'nin discovery belgeleri).
  ⚠️ **Doğrulanmadı:** canlı denenmedi. İade satırlarının tutar işareti belgelenmemiştir (mutlak değer alınır);
  `Active Subscriptions`'ın denemeleri içerdiği üçüncü taraf kaynaklara dayanır; satış raporu zip'inin içindeki CSV'nin
  kodlaması belgelenmemiştir (BOM'dan anlaşılır). Aynı aya ait dosya gün içinde yeniden yazılır; satır sırası değişse de
  imleç doğru çalışır.

---

## 7. Arayüz (UX/UI)

### 7.1 İndie minimalizm ilkeleri

1. **Cevap önce:** Dashboard'ın ilk satırı toplam MRR. Süs yok.
2. **Tek vurgu rengi** (marka mavisi), geri kalan nötr gri tonları. coss ui'nin ince gölgeleri ve 1px kenarlıkları, bol boşluk.
3. **Geist Sans + Geist Mono**, aynı kökenden; sayılarda `tabular-nums`. Harici font isteği yok.
4. Grafiklerde ve listelerde sağlayıcılar küçük renkli nokta ile ayrılır (veri renkleri `design/system.md` §3.1): Stripe `#635BFF`, Paddle `#2F80ED`, Lemon Squeezy `#AD7D00`, Polar `#0E9384`, RevenueCat `#F2545B`, Chargebee `#E8590C`, Dodo Payments `#4E9418`, Gumroad `#DB2777`, Adapty `#0A86B4`, Superwall `#858A00`, App Store Connect `#007AFF`, Google Play `#1E8E3E`, Demo nötr. Bağlantılar bölümünde (sağlayıcı seçimi, liste, form ve bağlantı başlığı) sağlayıcının kendi kare logosu gösterilir (`provider-logos.tsx`, kaynaklar dosyada).
5. Açık/koyu tema `prefers-color-scheme` ile otomatik (coss token'ları, hoomuch'un AA ölçülmüş paleti; `src/styles/app.css`).
6. **Formlar hydrate olmadan da çalışır:** Post/Redirect/Get, flash mesajlar çerezle. Hydrate olduktan sonra gönderilen formun butonunda spinner ve çift gönderim engeli, flash ve ilk-sayı şeridi Motion ile kapanır.
7. **Grafikler shadcn Charts / Recharts** ile tarayıcıda çizilir; sunucu HTML'inde metin açıklaması ve "Show data" altında veri tablosu bulunur.
8. İçerik genişliği ~960px. Mobilde tek sütun.
9. Arayüz dili İngilizce (v1); metinler kısa ve sakin ("Connected.", "Last synced 4 min ago").
10. **CSP uyumu:** inline `<script>` yok (`script-src 'self'`; sayfa verisi çalıştırılmayan bir JSON bloğu). Inline `style`'a Base UI, Recharts ve Motion için izin var (`style-src 'self' 'unsafe-inline'`).

### 7.2 Sayfalar

| Yol | İçerik |
|-----|--------|
| `/` | Landing: wordmark, tek cümlelik değer önerisi, "Get started" / "Log in", desteklenen sağlayıcı satırı. Giriş yapmışsa `/dashboard`'a yönlenir |
| `/signup`, `/login` | Tek kart, iki alan. Kayıt kapalıysa `/signup` bunu söyler |
| `/verify-email` | E-posta doğrulaması açıkken onaylanmamış hesabın tutulduğu "Check your inbox" kartı: bağlantının gittiği adres, "Send the link again", çıkış. Navigasyon yok |
| `/verify-email/confirm?token=` | E-postadaki bağlantı: tek düğmeli onay kartı (GET hiçbir şey değiştirmez); süresi geçmiş ya da geçersiz bağlantıda bunu söyler |
| `/dashboard?range=7\|30\|90` | KPI şeridi (MRR büyük), dönem seçici, gelir grafiği, MRR trendi, bağlantı ve ürün kırılım tabloları, uyarılar. Bağlantı yoksa boş durum + "Connect" / "Try demo data" |
| `/connections` | Bağlantı listesi: renk noktası, ad, sağlayıcı, durum rozeti, son senkronizasyon, son hata |
| `/connections/new` | Sağlayıcı seçimi (10 logolu kart + demo satırı) |
| `/connections/new?provider=…` | Dinamik form (`ProviderMeta.fields`), anahtar oluşturma adımları, gerekli izinler, uyarı |
| `/connections/:id` | Detay: durum, son hata, son senkronizasyonun uyarıları (F-19), son snapshot'lar, katlanmış senkronizasyon geçmişi, webhook destekleyen sağlayıcılarda "Real-time updates" kartı (F-17: Turn on; açıkken URL, kopyala, sağlayıcıdaki adımlar ve seçilecek olaylar, son çağrı zamanı, New URL, Turn off). Birincil eylem Sync now; son senkronizasyon hatalıysa "Replace key". Yeniden adlandır, anahtar yenile ve sil (onay kutusu ile) tek bir "Manage" bölümünde, gerekmedikçe kapalı. Demo bağlantı başlıktan tek tıkla kaldırılır |
| `/transactions?provider=&page=` | Birleşik işlem tablosu |
| `/settings` | Para birimi, saat dilimi (F-20), parola değiştirme, hesabı silme (onay kutusu + parola) |
| `POST /webhooks/:id/:token` | Sağlayıcı webhook'u (F-17): oturum yok, CSRF yok, JSON yanıt; §4.1 "Webhook" |
| `/healthz` | `{"ok":true}` |

### 7.3 Bileşenler

`Layout` (üst navigasyon), `Flash`, `KpiStat`, `DeltaBadge`, `ProviderDot`, `StatusBadge`, `EmptyState`,
`RangeTabs`, `RevenueChart` (yığılmış çubuk SVG), `MrrChart` (çizgi/alan SVG), `BreakdownTable`, `ProductTable`,
`ConnectionForm`, `DangerZone`, `RelativeTime`.

---

## 8. Güvenlik

| Konu | Karar |
|------|-------|
| Kimlik bilgisi şifreleme | `ENCRYPTION_KEY` (32 bayt, base64) Worker secret. AES-256-GCM, rastgele 12 bayt IV, biçim `v1.<iv>.<ciphertext>` (base64url). `v1` öneki anahtar rotasyonuna izin verir |
| Parola | PBKDF2-SHA256, 100.000 iterasyon (Workers üst sınırı), 16 bayt tuz, sabit zamanlı karşılaştırma. Min. 10 karakter |
| Oturum | 32 bayt rastgele token → `__Host-hm_session` çerezi (HttpOnly, SameSite=Lax, Secure, Path=/; yalnızca düz HTTP localhost'ta önek ve Secure yok). 30 gün kayan yenileme, **90 gün mutlak üst sınır**. D1'de yalnızca SHA-256 hash. Girişte eski oturum iptal edilir; parola değişince **tüm** oturumlar (mevcut dahil) iptal edilip yeni token verilir |
| CSRF | Hono `csrf()` (Origin kontrolü) + SameSite=Lax. Yalnızca `/webhooks/` yolu muaf: sağlayıcılar tarayıcı değildir ve oturum taşımaz (Gumroad form-encoded gönderir); kendi URL token'ı vardır |
| Webhook | URL token'ı `HMAC-SHA256(HKDF(ENCRYPTION_KEY, "hoomuch webhook url v1"), "<id>:<nonce>")`, 256 bit; saklanmaz, sabit zamanlı karşılaştırılır. Geçersiz kimlik, kapalı webhook, webhook sunulmayan sağlayıcı, yanlış token aynı `404`'ü alır (hangi bağlantının var olduğu sızmaz). Gövde hiç okunmaz, saklanmaz, loglanmaz (müşteri e-postası taşıyabilir); log yalnızca `{connectionId, scheduled}`, hata olursa `{connectionId, message}` (yalnızca hatanın adı). Token bir sırdır: beklenmeyen bir hatanın logundaki yolda `/webhooks/<id>/…` olarak kesilir. Sağlayıcı imzası doğrulanmaz: geçerli bir çağrı yalnızca salt okunur anahtarla, bağlantı başına en çok 5 dk'da bir senkronizasyon başlatabilir. `ENCRYPTION_KEY` değişirse URL'ler de değişir |
| HTTP başlıkları | CSP: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` + HSTS, nosniff, Referrer-Policy. Turnstile açıksa yalnızca `/login` ve `/signup` sayfalarında `script-src` ve `frame-src`'ye `https://challenges.cloudflare.com` eklenir |
| Deneme sınırı | Sayaç, pahalı PBKDF2'den **önce** tek bir `INSERT … ON CONFLICT … RETURNING` ile atomik artırılır (paralel isteklerle aşılamaz). Giriş: e-posta + ağ başına 15 dk'da 10, hesap başına (tüm ağlar) 15 dk'da 50, **ağ başına (tüm e-postalar) 15 dk'da 30** (credential stuffing'i ve bir ağın harcatabileceği CPU'yu sınırlar); aşılınca 429. Parola teyidi (parola değiştirme, hesap silme): kullanıcı başına 15 dk'da 10. Kayıt: ağ başına 15 dk'da 10 deneme (hesap üretimini ve e-posta yoklamasını sınırlar) ve **ağ başına günde 5 yeni hesap** (yalnızca kayıt gerçekten oluşacakken sayılır). Onay bağlantısını yeniden gönderme: hesap başına 15 dk'da 3, günde 10. IPv6 adresleri /64 olarak gruplanır. Süresi geçen satırları cron siler; günlük sayaçların anahtarı `day:` önekiyle bir gün tutulur |
| İstek sınırı | Cloudflare Rate Limiting binding'leri, D1'e dokunmadan **önce**, ağ başına: tüm istekler dakikada 300 (`RL_REQUESTS`), giriş ve kayıt gönderimleri dakikada 10 (`RL_AUTH`); aşılınca 429 + `Retry-After: 60`. Webhook'lar ağ başına sınırdan muaftır (sağlayıcı tüm kiracıların çağrılarını aynı adreslerden yollar) ve bunun yerine bağlantı başına dakikada 30 ile sınırlıdır (`RL_WEBHOOKS`). Sayaçlar Cloudflare lokasyonu başına ve yaklaşıktır; kesin sınırlar D1'dedir. Binding yoksa ya da hata verirse istek geçer (fail open) |
| Bot koruması | Giriş ve kayıt formlarında görünmeyen bir bal küpü alanı (`website`, `display: none`, `aria-hidden`); doluysa istek 400 ile reddedilir, e-posta ve IP loglanmaz. İsteğe bağlı Cloudflare Turnstile: `TURNSTILE_SITE_KEY` ve `TURNSTILE_SECRET_KEY` ikisi de tanımlıysa açılır; token Siteverify ile doğrulanır, `action` (`login`/`signup`) ve `hostname` eşleşmelidir; Siteverify'a ulaşılamazsa form reddedilir (fail closed, 503) |
| Tek kullanımlık e-posta | Kayıtta [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) listesi (CC0) reddedilir; alan adı ve tüm üst alan adları kontrol edilir (`x@a.mailinator.com` → `mailinator.com`). Liste `src/lib/disposable-domains.ts` içinde, kaynak commit'e sabitlenmiş olarak tutulur; çalışma anında ağ çağrısı yoktur. `npm run domains:update` ile yenilenir |
| Yetkilendirme | Her sorgu `user_id` ile kapsamlı; bağlantı ID'leri UUID |
| Açık yönlendirme | `?next=` izin listesiyle: `/` ile başlar, `//` ile başlamaz, yalnızca yazdırılabilir ASCII, ters eğik çizgi yok (tarayıcıların sildiği tab/CR/LF ile `//evil.com` üretilemez) |
| Önbellek | Worker'ın döndürdüğü tüm sayfalar `Cache-Control: no-store` |
| Kaynak sınırı | Kullanıcı başına 25 bağlantı, koşullu `INSERT … SELECT … WHERE COUNT < 25` ile atomik |
| E-posta doğrulama | İsteğe bağlı; `RESEND_API_KEY` secret'ı tanımlıysa açılır (gönderen: `MAIL_FROM` var'ı). Posta [Resend](https://resend.com) HTTP API'sine tek bir `fetch` ile gider, npm paketi yok. Kayıttan sonra 32 bayt rastgele token içeren bir bağlantı gönderilir; D1'de yalnızca SHA-256 hash'i saklanır (`email_verifications`), **24 saat** geçerlidir ve tek kullanımlıktır (satır tek bir `DELETE … RETURNING` ile harcanır, eşzamanlı iki tıklama ikisi birden geçemez). Bağlantının GET'i yalnızca bir onay düğmesi gösterir; onayı POST yapar, böylece e-postadaki her bağlantıyı açan tarayıcı/güvenlik tarayıcıları adresi kendiliğinden onaylayamaz. Onay oturum açmaz. Onaylanmamış hesap oturum açabilir ama `requireUser` arkasındaki her sayfa ve eylem `/verify-email`'e yönlenir. Yeniden gönderme yukarıdaki sınırlarla. Bütün bağlantıları süresi geçmiş, onaylanmamış ve bağlantısı (connection) olmayan hesap cron'da silinir; aynı adresle yeni kayıt geldiğinde de anında silinir, böylece başkasının adresini yazmak gerçek sahibini kilitleyemez. Hiç bağlantı gönderilmemiş hesaba (posta kapalıyken açılmış) dokunulmaz. Migration 0004'ten önceki hesaplar onaylı sayılır. Posta gönderilemezse kayıt yine olur, kullanıcı tekrar gönderebilir; log'a yalnızca HTTP durumu ve Resend hata kodu yazılır, adres, token ve bağlantı **asla** |
| Loglama | Anahtar, token, parola, şifreli blob, e-posta onay token'ı ve gönderilen adres **asla** loglanmaz; sağlayıcı hata gövdeleri ≤ 300 karaktere kırpılır ve anahtar benzeri dizgeler maskelenir |

---

## 9. Proje yapısı ve sahiplik

```
hoomuch/
├─ SPEC.md                       Lead
├─ wrangler.jsonc, package.json, tsconfig.json, vitest.config.ts   Lead
├─ migrations/000N_*.sql         Lead
├─ public/                       Experience (app.css derlenir, elle düzenlenmez)
├─ src/
│  ├─ index.tsx                  Lead — uygulama kablolaması, middleware, scheduled()
│  ├─ env.ts                     Lead — Bindings, AppEnv
│  ├─ lib/                       Lead — crypto, auth, money, time, flash
│  ├─ db/queries.ts              Lead — users/sessions/connections temel sorguları
│  ├─ providers/types.ts         Lead — ADAPTÖR KONTRATI
│  ├─ providers/registry.ts      Lead — sağlayıcı meta verisi + adaptör eşlemesi
│  ├─ providers/{http,stripe,paddle,lemonsqueezy,polar,revenuecat,chargebee,dodo,gumroad,adapty,superwall,demo}.ts   Data Plane
│  ├─ sync/                      Data Plane — engine, queue (üretici), consumer (kuyruk tüketicisi), fx, repo
│  ├─ data/types.ts              Lead — OKUMA MODELİ KONTRATI
│  ├─ data/{dashboard,transactions,connections,calendar,days}.ts   Data Plane
│  ├─ services/{connections,webhooks}.ts    Data Plane (imzalar Lead tarafından sabitlendi)
│  ├─ routes/                    Experience
│  ├─ views/                     Experience
│  └─ styles/app.css             Experience
└─ test/
   ├─ lib/                       Lead
   └─ providers/, sync/, fixtures/   Data Plane
```

### 9.1 Kontratlar (değiştirmek için Lead onayı gerekir)

- `src/providers/types.ts` — `ProviderAdapter` (v1.1: isteğe bağlı `fetchSnapshotHistory`; isteği sahibin yerel `today`'ini taşır), `ProviderMeta` (v1.1: `webhook`, `dayZone`), `ProviderContext` (v1.1: `deadline`, `signal`), `MetricsSnapshot` (v1.1: `warnings`), `RevenueEvent`, `DailyRevenuePoint`, `RevenuePage`, `ProviderError`
- `src/data/types.ts` — `DashboardData` (v1.1: `fx.daily`, `days`, dolu `warnings`), `CalendarMonth`, `CalendarDay`, `TransactionPage`, `ConnectionSummary`, `ConnectionDetail` (v1.1: `warnings`, `webhook`)
- `src/services/connections.ts` — `createConnection`, `renameConnection`, `rotateCredentials`, `deleteConnection`, `triggerSync`, `startSync` (v1.1: senkronizasyonları kuyruğa koyar, `ExecutionContext` almaz); `src/services/webhooks.ts` — `setWebhook`, `receiveWebhook`
- `src/data/*.ts` — `getDashboardData`, `getCalendarMonth`, `listTransactions`, `listConnectionSummaries`, `getConnectionDetail`
- `src/sync/engine.ts` — `syncConnection`, `runScheduledSync`; `src/sync/queue.ts` — `SyncMessage`, `enqueueSync(s)`; `src/sync/consumer.ts` — `handleSyncBatch`

---

## 10. Ekip ve çalışma düzeni

| Rol | Sorumluluk |
|-----|------------|
| **Lead** (ana session) | Spec, iskelet, kontratlar, entegrasyon, uçtan uca doğrulama, güvenlik incelemesi, deploy |
| **Data Plane** (alt session) | Sağlayıcı adaptörleri, HTTP/retry, sync engine, FX, okuma modelleri, servisler, testler |
| **Experience** (alt session) | Tasarım sistemi (coss ui + tema token'ları), layout, sayfalar, route'lar, grafikler, erişilebilirlik |

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
| M1 | Data Plane | 11 adaptör (10 sağlayıcı + demo) + sync engine + FX + okuma modelleri; testler yeşil |
| M2 | Experience | Tüm sayfalar, boş durumlar, açık/koyu tema; fixture verisiyle dashboard |
| M3 | Entegrasyon | Kayıt → demo bağlantı → dolu dashboard uçtan uca; `npm run check` yeşil |
| M4 | Dağıtım | D1 oluşturuldu, migration, secret, `wrangler deploy` (kullanıcı onayıyla) |

**Definition of Done (v1):**
- Yeni kullanıcı kayıt olur, demo bağlantı ekler ve dashboard birkaç saniye içinde dolar.
- Hiçbir sağlayıcının geçersiz anahtarı kaydedilmez; kullanıcı sebebi görür.
- Dashboard 7/30/90 gün arasında geçiş yapar; para birimi değişince tüm tutarlar çevrilir.
- Bir bağlantının hatası dashboard'ı bozmaz; hata bağlantı satırında görünür.
- Hiçbir sayfada inline script yok; CSP ihlali konsolda görünmez.
- `npm run check` (typecheck + test + css) yeşil.

**Definition of Done (v1.1):**
- Her senkronizasyon kuyruk tüketicisinde çalışır; cron, yeni bağlantı, Sync now ve anahtar yenileme kuyruğa koyar;
  aynı bağlantı iki kez kuyruğa girmez.
- Webhook açılmış bir bağlantıya üç hızlı çağrı tek bir `webhook` senkronizasyonu üretir; yanlış token 404 alır; gövde
  hiçbir logda görünmez.
- Eksik izinli bir Stripe anahtarı dashboard'da ve bağlantı sayfasında adıyla uyarı gösterir.
- İki farklı günde gelen EUR geliri kendi günlerinin kuruyla, MRR güncel kurla çevrilir.
- Los Angeles diliminde bir kullanıcı için akşam saatindeki satış o günün çubuğunda görünür; günlük toplam veren
  sağlayıcıların kendi günü dashboard'da belirtilir.

---

## 12. Riskler ve açık sorular

| Risk | Etki | Azaltma |
|------|------|---------|
| RevenueCat `charts:read` izni verilmemiş olabilir | RC için günlük gelir grafiği yok | Snapshot geliri + uyarı ile zarif düşüş |
| Bir senkronizasyon tek çağrıya sığmaz | Backfill birkaç senkronizasyona yayılır | v1.1: her senkronizasyon kendi kuyruk çağrısında (4 dk son tarih + cursor) |
| Free plan Queues kotası (günde 10.000 işlem) | Çok bağlantılı ya da yoğun webhook'lu kurulumda kota dolar | Webhook senkronizasyonları bağlantı başına 5 dk arayla; README Free plan sınırını söyler |
| frankfurter.dev harmanlanmış kurları sonradan küçük oynayabilir | Geçmiş gün geliri birkaç kuruş farklı olabilir | Kur kendi gününe yazılır; günlük çekim her para biriminin yalnızca en yeni kurunu getirdiği için bir günün kuru, o para biriminin en yeni kuru olduğu sürece sonraki çekimlerle değişebilir (`json_patch`, yeni gelen kazanır), sonra sabit kalır; geçmiş bir kez çekilir; ECB yayımladığı yerde ECB kuru |
| Günlük toplam veren sağlayıcılar kullanıcının diliminde gruplanamaz | O sağlayıcıların günü kullanıcının gününden kayabilir | `ProviderMeta.dayZone` ile dashboard'da açıkça belirtilir |
| Free plan CPU limiti | Giriş/senk. başarısız olabilir | Paid plan önerisi (README) |
| Stripe indirim/tiered fiyat kenar durumları | MRR sapması | Metered hariç, tiered = 0 + log; testlerle kapsanır |

### 12.1 v1.1 teknik borç (ekiplerden gelen kontrat talepleri) — tamamlandı

- ✅ `ProviderAdapter.fetchSnapshotHistory?` (opsiyonel) — engine'deki demo'ya özel dal kalktı; demo, Adapty (§6.11) ve
  Superwall (§6.12) uyguluyor. Paddle ve Polar'ın serilerinde abonelik sayısı olmadığı için onlarda yok.
- ✅ `MetricsSnapshot.warnings?: string[]` — adaptör uyarıları dashboard'a ve bağlantı sayfasına taşındı (F-19).
- ✅ `ProviderContext.deadline` / `signal` — engine'deki getter çözümü (`withDeadline`) kalktı.
- ✅ Cron → Cloudflare Queues fan-out; sağlayıcı webhook'ları (F-17).
- ✅ Tarihsel döviz kuru (frankfurter.dev v2); kullanıcı saat dilimine göre gün sınırları (F-20).
