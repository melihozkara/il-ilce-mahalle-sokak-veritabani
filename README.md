
# Türkiye Adres İl İlçe Mahalle Sokak Veritabanı

SQL Data Tarihi: 12.04.2026

Bir projede il ilçe mahalle datasına ihtiyacım oldu ve internette bulduğum kaynaklar genellikle eski datalardı. Bi kaç ay önce paylaşılmış  datalarda bile eksik mahalleler vs. olabiliyordu. Bunun haricinde istediğim formatta veya veritabanına ait olmayabiliyordu. Gördüğüm kadarıyla genellikle insanlar datayı çekip paylaşmış ama pek kimse datayı çektiği kodla birlikte paylaşmamış. Yani istediğimiz veritabanına istediğimiz gibi çekemiyoruz.

Bu yüzden datayı ve kodu paylaşıyorum. Aslında basit bir kod zor bir yanı yok, sayfayı inceleyerek kolay bir şekilde bu kodu yazabilirsiniz.

Veriler https://adres.nvi.gov.tr/VatandasIslemleri/AdresSorgu bağlantısından çekilmektedir. İlk istekte reCaptcha bulunduğu için bir reCaptcha çözücü kullandım. NVI'dan gelen tüm data büyük harfli. sql klasöründe hem büyük harfli hem de sadece baş harfleri büyük (title case) versiyonunu bulabilirsiniz. Kendiniz üretmek isterseniz build-sql.mjs --case=title veya --case=upper ile seçebilirsiniz.

İster kendiniz çekin, ister verdiğim sqlleri kullanın, isterseniz kodu geliştirip projelerinizde kullanın. Tek ricam kullanırsanız repoya yıldız vermeyi unutmayın :)



## Güncel data şu şekilde;

```bash 
  İl: 81
  İlçe: 973
  Mahalle: 73,496
  Sokak / Cadde / Semt: 1,270,829
```

Bir önceki data (18.02.2025) ile karşılaştırma:

```
  Mahalle:  73,479  →  73,496   (+17)
  Sokak:  1,254,409  →  1,270,829  (+16,420)
```

İller;
```bash 
id,
name,
plaka
```

İlçeler;
```bash 
id,
name,
kimlikNo,
il_id
```

Mahalleler;
```bash 
id,
name, // Örnek: Cumhuriyet
bilesenName, // Örnek: Cumhuriyet Mahallesi
kimlikNo,
il_id,
ilce_id
```

Sokaklar / Semtler / Caddeler;
```bash 
id,
name, // Örnek: Hisar
bilesenName, // Örnek: Hisar (Sokak)
il_id,
ilce_id,
mahalle_id
```

Veriler bana mysql ve postgresql tarafında lazım olduğu için dataları bu şekilde çekip db ye göre export kodu yazdım. Kodda bir kaç düzenleme ile istediğiniz veritabanına dataları çekebilirsiniz.

Dataları çekip kullanacağım zaman fark ettim ki projemde ki bir çok verinin yalnızca baş harfleri büyük. Çektiğim datada tüm harfler büyük. Bu yüzden kendime göre düzenleyip yalnızca baş harfleri büyük olacak şekilde düzenledim. İki datayı da sql olarak ekliyorum, hangisi size uygunsa onu kullanın.

Data klasörünü ve build-sql dosyasını bilerek repoya ekledim. build-sql.mjs ile MySQL ve PostgreSQL için hazır SQL çıktısı alabilirsiniz. Farklı bir veritabanı motoru kullanacaksanız build-sql dosyasını biraz değiştirip istediğiniz şekilde export alabilirsiniz.

## ÖNEMLİ

Kodda güncelleme yapacaksanız veya datayı kendiniz çekecekseniz çok fazla istek gönderildiğini unutmayın. Olabildiğince kodu inceleyip botu başlatın. Eğer mysqlde işlem yapacaksanız ve column, case tipi gibi özellikleri değiştirecekseniz verdiğim datayı kullanarak yapabilirsiniz. Sıfırdan data çekilmesini yalnızca bu repoda bulunan datalar eskidinde yapmanızı öneririm. Ortalama 75,000 istek gönderiliyor ve tüm datanın çekilmesi 4 proxy ile yaklaşık 15 saat civarı sürüyor. Bu az bir istek sayısı veya süre değil.

Data çekerken 2500ms delay ile istek atın. Bu şekilde dakikada 24 istek gönderilir. Dakikada 30+ istek attığımda proxylerden birini 6 saat blokladı sistem. 

reCaptcha çözümü için 2Captcha.com sitesini kullandım. Siteye 1 dolar gibi bakiye yükleyip api key alabilirsiniz. Site ile bir bağlantım yok, sadece eski projelerden bakiyem olduğu için burayı kullandım.

Dataları çekerlerken id değerlerini mutlaka gelen datada ki kimlikNo dan alın. Mahalle vs. isimlerinde güncellemeler, eklemeler olabiliyor. Eğer auto increment veya random id kullanırsanız ilerleyen süreçte dataları güncellerken karışıklık yaşayabilirsiniz.


## Geri Bildirim

Datalara bir güncelleme geldiyse veya https://adres.nvi.gov.tr/VatandasIslemleri/AdresSorgu sitesinde değişiklikler yapıldıysa kodu güncellemem için bana email gönderebilirsiniz. mail[@]melih.org 

  