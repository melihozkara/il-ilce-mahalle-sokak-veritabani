import puppeteer from 'puppeteer';
import fs from "fs";
import Captcha from "2captcha"
import * as mysql from "mysql2/promise";
import {toTitleCase} from "titlecase";


const COOKIE_PATH = './cookies.json';
const LOCAL_STORAGE_PATH = './localStorage.json';
const SITE_TOKEN_PATH = './token.json';

const solver = new Captcha.Solver("2CAPTCHA API KEY")

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'adres_data',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

let totalInsert = 0;
async function insertData(tableName, data) {
    let connection;
    try {
        connection = await pool.getConnection();
        if (!connection) {
            throw new Error("MySQL bağlantısı alınamadı!");
        }

        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = keys.map(() => "?").join(", ");
        const sql = `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`;
        const [result] = await connection.execute(sql, values);
        totalInsert++;
        return result.insertId;
    } catch (error) {
        console.error("Veri eklenirken hata oluştu:", error);
        throw error;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

function capitalizeTurkish(str) {
    if (typeof str !== 'string') {
        return str;
    }

    return toTitleCase(str.toLocaleLowerCase('tr-TR'));
}

async function saveSessionData(page) {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
    const siteKey = await page.evaluate(() => {
        return window.kale?.serverDefinitions?.reCaptcha?.siteKey || null;
    });

    const tokenValue = await page.evaluate(() => {
        const inputElement = document.querySelector('input[name="__RequestVerificationToken"]');
        return inputElement ? inputElement.value : null;
    });
    fs.writeFileSync(SITE_TOKEN_PATH, JSON.stringify({
        'token': tokenValue,
        'siteKey': siteKey,
    }, null, 2));

    const localStorageData = await page.evaluate(() => {
        let json = {};
        for (let i = 0; i < localStorage.length; i++) {
            let key = localStorage.key(i);
            json[key] = localStorage.getItem(key);
        }
        return json;
    });
    fs.writeFileSync(LOCAL_STORAGE_PATH, JSON.stringify(localStorageData, null, 2));

    console.log('Session Verileri Kayıt Edildi.');
}

function captchaResolve() {
    console.log('reCaptcha çözülüyor.');
    const siteToken = JSON.parse(fs.readFileSync(SITE_TOKEN_PATH, 'utf-8'));
    return new Promise((resolve) => {
        solver.recaptcha(siteToken.siteKey, "https://adres.nvi.gov.tr/VatandasIslemleri/AdresSorgu")
            .then((res) => {
                resolve({ status: true, ...res });
            })
            .catch((err) => {
                resolve({ status: false, error: err.message });
            });
    });
}

async function sessionRefresh() {
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
        ]
    });
    const page = await browser.newPage();
    await page.goto('https://adres.nvi.gov.tr/VatandasIslemleri/AdresSorgu');
    await page.waitForResponse(() => true)
    await page.goto('https://adres.nvi.gov.tr/VatandasIslemleri/AdresSorgu');
    await saveSessionData(page)
    await browser.close()
    return true
}

async function requestNvi(url, body) {
    try {
        const siteToken = JSON.parse(fs.readFileSync(SITE_TOKEN_PATH, 'utf-8'));
        const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'));
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

        return new Promise((resolve, reject) => {
            fetch(url, {
                "headers": {
                    "__requestverificationtoken": siteToken.token,
                    "accept": "*/*",
                    "accept-language": "tr-TR,tr;q=0.5",
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "sec-ch-ua": "\"Brave\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": "\"macOS\"",
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "same-origin",
                    "sec-gpc": "1",
                    "x-requested-with": "XMLHttpRequest",
                    "cookie": cookieString,
                    "Referer": url,
                    "Referrer-Policy": "same-origin"
                },
                "body": body,
                "method": "POST"
            })
                .then((response) => response.text())  // Veriyi text olarak al
                .then((text) => {
                    try {
                        let data = JSON.parse(text); // JSON parse yap
                        if (!Array.isArray(data)) {
                            data = [data]; // Eğer JSON obje ise array'e çevir
                        }
                        resolve(data); // Veriyi Promise çözümü olarak döndür
                    } catch (error) {
                        console.error("JSON parse hatası:", error, text);
                        reject(error); // JSON hatası alırsa reject et
                    }
                })
                .catch(error => {
                    console.error("İstek hatası:", error);
                    reject(error); // Fetch hatası olursa reject et
                });
        });

    } catch (error) {
        console.error("Dosya okuma hatası:", error);
        return Promise.reject(error); // Dosya okuma hatası olursa reject et
    }
}

async function run() {
    await sessionRefresh()
    let captcha = await captchaResolve();
    if (!captcha.status) {
        console.log('Captcha çözülürken bir hata oluştu.')
        return
    }

    let iller = await requestNvi(
        'https://adres.nvi.gov.tr/Harita/ilListesi',
        null
    )

    for (const il of iller) {
        console.log(`ID: ${il.kimlikNo} - Name: ${il.adi} - Total Insert: ${totalInsert}`);
        await insertData('iller', {
            id: il.kimlikNo,
            name: capitalizeTurkish(il.adi),
            plaka: il.kimlikNo,
        })


        let ilceler = await requestNvi(
            'https://adres.nvi.gov.tr/Harita/ilceListesi',
            `ilKimlikNo=${il.kimlikNo}&adresReCaptchaResponse=${captcha.data}`
        )

        for (const ilce of ilceler) {
            await insertData('ilceler', {
                id: ilce.kimlikNo,
                name: capitalizeTurkish(ilce.adi),
                kimlikNo: ilce.kimlikNo,
                il_id: il.kimlikNo,
            })

            let mahalleler = await requestNvi(
                'https://adres.nvi.gov.tr/Harita/mahalleKoyBaglisiListesi',
                `ilceKimlikNo=${ilce.kimlikNo}&adresReCaptchaResponse=`
            )

            for (const mahalle of mahalleler) {
                await insertData('mahalleler', {
                    id: mahalle.kimlikNo,
                    name: capitalizeTurkish(mahalle.adi),
                    bilesenName: capitalizeTurkish(mahalle.bilesenAdi),
                    kimlikNo: mahalle.kimlikNo,
                    il_id: il.kimlikNo,
                    ilce_id: ilce.kimlikNo,
                })

                let csbms = await requestNvi(
                    'https://adres.nvi.gov.tr/Harita/yolListesi',
                    `mahalleKoyBaglisiKimlikNo=${mahalle.kimlikNo}&adresReCaptchaResponse=`
                )

                for (const csbm of csbms) {
                    await insertData('csbms', {
                        id: csbm.kimlikNo,
                        name: capitalizeTurkish(csbm.adi),
                        bilesenName: capitalizeTurkish(csbm.bilesenAdi),
                        il_id: il.kimlikNo,
                        ilce_id: ilce.kimlikNo,
                        mahalle_id: mahalle.kimlikNo,
                    })
                }
            }
        }
    }
    console.log(`${totalInsert} adet veri eklendi.`)
    return true
}

run()