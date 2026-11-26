# 🧛 Vampir Köylü

Moderatörsüz Vampir Köylü oyunu. Herkes kendi telefonundan oda koduyla girer; sunucu geceyi, oylamayı ve kazananı otomatik yönetir.

## Oynanış
1. Biri "Yeni oda kur" der, 4 harfli kodu paylaşır. Diğerleri "Odaya katıl" ile girer.
2. Oda kurucusu **vampir sayısını** (varsayılan 1), Doktor/Kâhin rollerini ve tartışma süresini ayarlar. Minimum 4 oyuncu.
3. Herkes rolünü ekranda **basılı tutarak** görür.
4. **Gece:** vampirler kurban seçer, Doktor korur (aynı kişiyi üst üste iki gece koruyamaz, kendini koruyabilir), Kâhin bir kişiye bakar. Özel rolü olmayanlar da sahte bir seçim yapar, böylece kimin rolü olduğu anlaşılmaz.
5. **Gün:** yüz yüze tartışılır. Çoğunluk "oylamaya geçelim" derse veya süre dolarsa oylama başlar.
6. **Oylama:** en çok oyu alan elenir, rolü açıklanır. Eşitlikte veya "kimseyi eleme" çoğunluktaysa kimse elenmez. Her oylamadan sonra herkes **sonuç ekranını** görür: kim kime oy verdi, oy çubukları ve elenenin rolü. Herkes "Devam"a basınca (veya 20 sn sonra) oyun sürer. Oylama en fazla 2 dakika sürer.
7. Tüm vampirler elenirse köy, vampirler köylülere eşitlenirse vampirler kazanır.

**Animasyonlar:** gece/gün geçişleri, ölen oyuncuya özel "ÖLDÜN" ekranı (titreşimli), dönen rol kartı, oy çubukları, kazanan konfetisi.

Telefon kapanıp ekran kilitlenirse sayfa yeniden açıldığında oyuna otomatik geri dönülür.

## Yerelde çalıştırma
```bash
npm install
npm start      # http://localhost:3000
npm test       # 6 kişilik otomatik oyun simülasyonu
```

## Railway'e yayınlama
1. Bu repoyu GitHub'a push'la.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → bu repoyu seç.
3. Deploy bitince projede **Settings → Networking → Generate Domain** de.
4. Çıkan `https://....up.railway.app` adresini herkese gönder.

Ek ayar gerekmez: Railway `npm start` komutunu ve `PORT` değişkenini otomatik kullanır. Oda durumu bellekte tutulur; sunucu yeniden başlarsa açık odalar sıfırlanır.
