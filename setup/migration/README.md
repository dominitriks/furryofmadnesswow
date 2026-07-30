# Пакет за преместване на сървъра

Всичко, което новата машина трябва да изтегли от git. Пълното ръководство е в
[`../../MIGRATION.md`](../../MIGRATION.md) — тук е само какво има в тази папка и
какво да се прави с него.

---

## Съдържание

| Файл | Какво е |
|---|---|
| `db-auth.sql.gz.enc` | `acore_auth` — акаунти, GM права, realmlist. **Шифрован** |
| `db-characters.sql.gz.enc` | `acore_characters` — герои, гилдии, поща, предмети. **Шифрован** |
| `protect-dumps.ps1` | Шифрова/дешифрова горните два |
| `source-version.txt` | Точните commit-и на ядрото и модула |
| `config-diff.md` | Всички разлики от стандартните настройки (пароли скрити) |
| `world-db-changes.md` | Ръчни промени в `acore_world`? Отговор: няма |

---

## Защо дъмповете са шифровани

`acore_auth.account` съдържа `salt` и `verifier` за всеки акаунт. Те са
**еквивалент на паролите** — който ги има, може да напада офлайн всеки акаунт,
включително администраторските, на сървър с отворени навън портове 3724 и 8085.
Таблицата пази още имейли и `last_ip`.

`github.com/dominitriks/furryofmadnesswow` е **публично**. Публикуването е
необратимо: изтриването на файла после не помага, защото той остава в историята
на git и във всяко копие, а публичните push-ове се обхождат и огледалират
в рамките на минути.

Затова файловете се шифроват преди commit. AES-256-CBC с ключ, изведен през
PBKDF2-SHA256 (200 000 итерации), и HMAC-SHA256, който се проверява **преди**
дешифроването — променен файл се проваля шумно.

**Паролата е в `setup\CREDENTIALS.txt`, раздел `MIGRATION DUMPS`.** Този файл не
влиза в git — пренеси го отделно (USB, мениджър на пароли, лично съобщение).

> Без паролата дъмповете са безполезни. Изгуби ли се, героите се губят.

---

## Стъпки на новата машина

### 1. Вземи репото

```powershell
git clone https://github.com/dominitriks/furryofmadnesswow.git wow
cd wow
```

Донеси отделно (не са в git): `setup\CREDENTIALS.txt`, `setup\db-password.txt`,
`cloud\agent\.env`.

### 2. Данните от клиента — 3.07 GB

**Не ги качвам в облачно хранилище — не са наши и вече са публични.**
`data.zip` е точно активът `Data.zip` от версия v19 на `wowgaming/client-data`,
същия, който ползва и официалният инсталатор на AzerothCore. Изтегли го от
първоизточника — по-бързо е и се проверява:

```powershell
Invoke-WebRequest -Uri "https://github.com/wowgaming/client-data/releases/download/v19/Data.zip" -OutFile Data.zip

# трябва да съвпадне:
(Get-FileHash Data.zip -Algorithm SHA256).Hash
# D37F19CBF3D1C57D965882340519E0275E0964554476117791AD06069A667B04

Expand-Archive Data.zip -DestinationPath server\Data
```

Съдържа `dbc` (248), `maps` (5 745), `vmaps` (12 495), `mmaps` (3 781),
`Cameras` (15) — 3.07 GB разархивирано.

> Ако старата машина е под ръка, копирането по локалната мрежа е още по-бързо.
> Така или иначе се спестяват 1–3 часа работа на `mmaps_generator`.

### 3. Изходен код

Точните версии са в `source-version.txt`. Ядрото и модулът са свързани —
винаги двата заедно:

```powershell
git clone https://github.com/mod-playerbots/azerothcore-wotlk.git --branch=Playerbot source
git -C source checkout ceeb3116ebedf4b35f12b75e5481b6ddd0de7a89

git clone https://github.com/mod-playerbots/mod-playerbots.git source\modules\mod-playerbots
git -C source\modules\mod-playerbots checkout 3fa1c1e49f8f1324b72461e576bce7c89b0a6521

cd source\modules\mod-playerbots
git apply ..\..\..\setup\patches\001-lfg-accept-in-combat.patch
cd ..\..\..
```

Единствената локална промяна в изходния код е `LfgActions.cpp` и тя е изцяло
покрита от този пач — сравнено ред по ред, 52 променени реда от двете страни.
Няма недокументирани промени.

Този етап е нужен **само** ако ще строиш наново. Ако копираш папката `server\`
от старата машина, двоичните файлове работят както са.

### 4. Toolchain — само при строене наново

Версиите не са по избор:

| Компонент | Версия | Защо |
|---|---|---|
| Git | 2.55.0.3 | — |
| VS 2022 Build Tools | MSVC **14.44 (v143)** | Boost-двоичните са `msvc-14.3`; v145 от VS 2026 не става |
| CMake | **3.31.8** | CMake 4.x чупи AzerothCore (issue #26544) |
| MySQL Server | **8.4.9** | — |
| OpenSSL | **3.6.2 FireDaemon** | slproweb връща 404 за 3.x; winget дава 4.0.1, което не става |
| Boost | **1.83.0 msvc-14.3** | mod-playerbots приема 1.78–1.83; **1.87+ е счупено** |
| Node.js | 24.x | панел, HUD, облачен агент |
| VC++ Redistributable 2015–2022 x64 | — | без него `worldserver.exe` умира с `0xc0000135` |

`BOOST_ROOT` = `C:/local/boost_1_83_0` (User scope стига).

Флаговете за строене и четирите DLL-а, които се копират на ръка — в
`MIGRATION.md`, раздел 2.4.

### 5. База данни

```powershell
mysql -u root -p < ..\01-create-databases.sql
```

⚠️ Този файл още съдържа **старата слаба парола** `acore`. Веднага след това
задай истинската от `db-password.txt`:

```sql
ALTER USER 'acore'@'localhost' IDENTIFIED BY '<от db-password.txt>';
```

Дешифровай и възстанови:

```powershell
cd setup\migration
.\protect-dumps.ps1 -Decrypt          # иска паролата от CREDENTIALS.txt

# разархивирай двата .gz
foreach ($f in Get-ChildItem *.sql.gz) {
    $in  = [System.IO.File]::OpenRead($f.FullName)
    $gz  = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    $out = [System.IO.File]::Create(($f.FullName -replace '\.gz$',''))
    $gz.CopyTo($out); $out.Close(); $gz.Close(); $in.Close()
}

mysql -u acore -p acore_auth       < db-auth.sql
mysql -u acore -p acore_characters < db-characters.sql
```

`acore_world` и `acore_playerbots` остават празни — запълват се сами при първото
пускане (виж `world-db-changes.md`).

### 6. Настройки

```powershell
.\setup\apply-settings.ps1 -FromDist
```

Връща и **31-те настройки**, и абсолютните пътища за новата машина. Обхваща
рейтовете за опит и плячка, броя и нивото на ботовете, бойните стратегии
(танкът напада пръв), изчакването при влизане в подземие, спрените шепоти.

`config-diff.md` показва същото в четим вид. Машинно четимият източник е
`setup\server-settings.conf`.

### 7. Адресът на реалма

Единственото, което **винаги** е грешно след преместване:

```sql
UPDATE acore_auth.realmlist
   SET address      = '<публичен IP или име на хост>',
       localAddress = '<LAN IPv4 на новата машина>'
 WHERE id = 1;
```

Без рестарт — authserver презарежда на всеки 20 секунди.

⚠️ Пренасочването в рутера сочи към стария LAN адрес — пренасочи 3724 и 8085 към
новия и направи DHCP резервация. Порт 3306 **никога** не се пренасочва.

### 8. Панел, HUD, агент

```powershell
cd panel ; npm install ; cd ..
cd cloud\agent ; npm install ; cd ..\..
.\panel\hud-launcher\build-hud.ps1
.\START-SERVER.ps1
```

---

## Проверка накрая

| | Очаквано |
|---|---|
| `setup\05-verify-no-client.ps1` | всичко зелено |
| `Auth.log` | `Added realm "..." at <новия адрес>` |
| акаунти / герои | 13 / 96 |
| панел | http://localhost:8080 |
| отвън | тествай от телефон на мобилни данни, **не** от локалната мрежа |

Тест отвътре в мрежата не доказва нищо — минава по `localAddress`.
