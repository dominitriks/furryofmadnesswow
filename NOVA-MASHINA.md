# Пренасяне на WoW сървъра на новата машина

Самостоятелен документ — не ти трябва нищо друго освен него.

**Какво е това:** World of Warcraft 3.3.5a (Wrath of the Lich King) сървър на
AzerothCore с mod-playerbots. Всичко наглаждано досега е записано и се
възстановява със скриптове. Нищо не се прави наново на ръка.

- Репо: `https://github.com/dominitriks/furryofmadnesswow`
- Целева папка: препоръчително `C:\wow` (пътят е без значение — скриптовете го
  извеждат сами)

---

## 0. Какво трябва да получиш ОТДЕЛНО от git

Тези файлове не са и няма да бъдат в репото.

| Файл | Размер | Бележка |
|---|---|---|
| `setup\CREDENTIALS.txt` | 7 KB | всички пароли — **най-важното** |
| `setup\db-password.txt` | 30 B | |
| `setup\gm-password.txt` | 18 B | |
| `cloud\agent\.env` | 521 B | ключове за Supabase |
| `mysql\my.ini` | 1.3 KB | конфигурация на MySQL |
| `server\` без `Data\` и `logs\` | 63 MB | само за Маршрут A |

> ⚠️ `CREDENTIALS.txt` съдържа паролата, която отключва дъмповете на базата,
> публикувани в **публичното** репо. Тя е единственото между интернет и
> акаунтите. Не я пращай по чат или имейл — USB или мениджър на пароли.
> **Без нея героите не могат да се възстановят.**

Не ти трябват: `public-ip.txt`, `hosts.backup`, `mysql\data\`.

---

## 1. Избери маршрут

| | **A — копиране** | **B — построяване наново** |
|---|---|---|
| Време | ~40 мин | ~4 часа |
| Нужен компилатор | не | да |
| Кога | просто местиш сървъра | ще променяш C++ кода |

**Маршрут A е препоръчителният.** Двоичните файлове работят на всяка x64
машина с Windows. Ако избереш A — прескочи раздел 4 изцяло.

---

## 2. Задължителен софтуер

За **двата** маршрута:

| Компонент | Версия |
|---|---|
| MySQL Server | **8.4.x** |
| Node.js | 24.x |
| Git | — |
| **VC++ Redistributable 2015–2022 x64** | ⚠️ лесно се пропуска |

> Без VC++ Redistributable `worldserver.exe` умира с `0xc0000135` и **нула реда
> в лога**. Ако това стане — това е причината.

Само за **Маршрут B** — версиите не са по избор, всяка е сложена по причина:

| Компонент | Версия | Защо |
|---|---|---|
| VS 2022 Build Tools | MSVC **14.44 (v143)** | Boost-двоичните са `msvc-14.3`; v145 от VS 2026 не става |
| CMake | **3.31.8** | CMake 4.x чупи AzerothCore |
| OpenSSL | **3.6.2 FireDaemon** | slproweb връща 404 за 3.x; winget дава 4.0.1, което не става |
| Boost | **1.83.0 msvc-14.3** | приемливо е 1.78–1.83; **1.87+ е счупено** |

`BOOST_ROOT` = `C:/local/boost_1_83_0` (User scope стига).

---

## 3. Вземи проекта

```powershell
cd C:\
git clone https://github.com/dominitriks/furryofmadnesswow.git wow
cd C:\wow
```

Сложи на местата им файловете от раздел 0:

```
C:\wow\setup\CREDENTIALS.txt
C:\wow\setup\db-password.txt
C:\wow\setup\gm-password.txt
C:\wow\cloud\agent\.env
C:\wow\mysql\my.ini
```

**Маршрут A:** разархивирай и папката `server\` тук → `C:\wow\server\`.

### Данните от клиента — 3.07 GB

Не се пращат — публични са. Изтегли ги от първоизточника:

```powershell
cd C:\wow
Invoke-WebRequest -Uri "https://github.com/wowgaming/client-data/releases/download/v19/Data.zip" -OutFile Data.zip

(Get-FileHash Data.zip -Algorithm SHA256).Hash
# трябва да е точно:
# D37F19CBF3D1C57D965882340519E0275E0964554476117791AD06069A667B04

Expand-Archive Data.zip -DestinationPath server\Data
mkdir server\logs -Force
```

Съдържа `dbc`, `maps`, `vmaps`, `mmaps`, `Cameras`.

> ⚠️ Липсваща папка `server\logs` **тихо изключва** записа в лог файлове.
> Създай я задължително.

---

## 4. Построяване — САМО Маршрут B

Прескочи целия раздел, ако си копирал `server\`.

### 4.1 Изходен код

Ядрото и модулът са свързани — винаги двата, на точно тези версии:

```powershell
cd C:\wow
git clone https://github.com/mod-playerbots/azerothcore-wotlk.git --branch=Playerbot source
git -C source checkout ceeb3116ebedf4b35f12b75e5481b6ddd0de7a89

git clone https://github.com/mod-playerbots/mod-playerbots.git source\modules\mod-playerbots
git -C source\modules\mod-playerbots checkout 3fa1c1e49f8f1324b72461e576bce7c89b0a6521
```

Приложи локалния пач — без него ботовете отказват RDF, докато са в бой, и
влизат в подземието без изчакване:

```powershell
cd C:\wow\source\modules\mod-playerbots
git apply ..\..\..\setup\patches\001-lfg-accept-in-combat.patch
cd C:\wow
```

Това е единствената промяна в чуждия код и е изцяло покрита от този пач.

### 4.2 Изключения на Defender

Иначе всяко построяване е пълно — час вместо минути. Иска администратор:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-File','C:\wow\setup\02-elevated-fixes.ps1'
```

### 4.3 Компилиране

```powershell
$env:PATH="C:\Program Files\Git\cmd;C:\Program Files\CMake\bin;$env:PATH"
mkdir C:\wow\build -Force; cd C:\wow\build

cmake "C:/wow/source" -G "Visual Studio 17 2022" -A x64 -T host=x64 `
  -DCMAKE_INSTALL_PREFIX="C:/wow/server" `
  -DTOOLS_BUILD=all -DSCRIPTS=static -DMODULES=static `
  -DBOOST_ROOT="C:/local/boost_1_83_0" `
  -DOPENSSL_ROOT_DIR="C:/Program Files/FireDaemon OpenSSL 3" `
  -DCMAKE_CXX_FLAGS="/DWIN32 /D_WINDOWS /EHsc /FS /MP4"

# провери ПРЕДИ да строиш:
Select-String -Path CMakeCache.txt -Pattern "^CMAKE_CXX_FLAGS:"
# резултатът ЗАДЪЛЖИТЕЛНО съдържа /EHsc

cmake --build . --config RelWithDebInfo --parallel 1
cmake --build . --config RelWithDebInfo --target install
```

> ⚠️ `CMAKE_CXX_FLAGS` **замества** стойностите по подразбиране на CMake, затова
> `/DWIN32 /D_WINDOWS /EHsc` се изписват отново. Изпуснеш ли `/EHsc`, всичко се
> проваля при свързване с `LNK2001: boost::throw_exception`. Това вече струва
> едно цяло построяване.
> `/FS` е срещу `C1041` (спор за `scripts.pdb`), `/MP4` ограничава паметта.
> `--parallel 1` не е грешка — `/MP` вече натоварва всички ядра.

### 4.4 Четирите DLL-а на ръка

Инсталацията **не копира нито един**:

```powershell
$s = "C:\wow\server"
copy "C:\Program Files\MySQL\MySQL Server 8.4\lib\libmysql.dll" $s
copy "C:\Program Files\FireDaemon OpenSSL 3\bin\libcrypto-3-x64.dll" $s
copy "C:\Program Files\FireDaemon OpenSSL 3\bin\libssl-3-x64.dll" $s
copy "C:\Program Files\FireDaemon OpenSSL 3\lib\ossl-modules\legacy.dll" $s
```

> ⚠️ `legacy.dll` е в `lib\ossl-modules\`, **не** в `bin\`. Липсва ли, сървърът
> прекъсва с код `-1073740768`.
> ⚠️ Не решавай това с добавяне на MySQL `bin\` към PATH — там има същите по име
> OpenSSL файлове, които засенчват правилните.

---

## 5. База данни

### 5.1 MySQL

Редактирай `C:\wow\mysql\my.ini` — два зашити пътя:

```ini
basedir = "C:/Program Files/MySQL/MySQL Server 8.4"
datadir = "C:/wow/mysql/data"          <- смени този
innodb_buffer_pool_size = 3G           <- вдигни: 50-60% от паметта
bind-address = 127.0.0.1               <- НЕ пипай
```

Като услуга, за да преживява рестарт (администратор):

```powershell
mysqld --install MySQL84 --defaults-file="C:\wow\mysql\my.ini"
net start MySQL84
```

### 5.2 Създай базите

```powershell
mysql -u root -p < C:\wow\setup\01-create-databases.sql
```

> ⚠️ Този файл още съдържа **старата слаба парола** `acore`. Веднага след него:

```sql
ALTER USER 'acore'@'localhost' IDENTIFIED BY '<от db-password.txt>';
```

### 5.3 Възстанови акаунтите и героите

Дъмповете са в репото, шифровани. Паролата е в `CREDENTIALS.txt`, раздел
`MIGRATION DUMPS`.

```powershell
cd C:\wow\setup\migration
.\protect-dumps.ps1 -Decrypt

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

`acore_world` и `acore_playerbots` остават **празни** — запълват се сами при
първото пускане (2767 SQL файла, ~15 мин).

> ⚠️ Не прекъсвай първия импорт. Запълването тръгва само ако базата е напълно
> празна, така че наполовина запълнена база **никога** няма да се допълни сама.
> Ако се прекъсне: `DROP DATABASE acore_world;`, създай я празна, почни отначало.
> Изглежда замръзнало по десетки минути — това е нормално.

---

## 6. Настройките — тук се връща цялата свършена работа

```powershell
cd C:\wow
.\setup\apply-settings.ps1 -FromDist
```

Една команда връща **31 настройки** и намества всички пътища за тази машина:

- рейтове за опит и плячка (3x убийства, 7x куестове, 2x пари)
- 40 бота на 80 ниво, с генерирани пароли
- бойни стратегии — танкът напада пръв, вместо да чака команда
- изчакване 25–50 сек. при влизане в подземие
- спрени шепоти към истинските играчи
- RDF маска, брой нишки, приоритет на процеса

Скриптът се проверява сам накрая и казва ясно, ако нещо не е минало.

> ⚠️ Задължително е и при Маршрут A — конфигурациите в копираната `server\`
> още сочат към старата машина.

---

## 7. Мрежа

### 7.1 Адресът на реалма

Единственото, което **винаги** е грешно след преместване:

```sql
UPDATE acore_auth.realmlist
   SET address      = '<публичен IP или име на хост>',
       localAddress = '<LAN IPv4 на ТАЗИ машина>'
 WHERE id = 1;
```

Без рестарт — authserver презарежда на всеки 20 секунди.

> ⚠️ Неразрешимо име кара реалма да **изчезне тихо** от списъка, вместо да даде
> грешка. Същото при грешна `localSubnetMask`.

### 7.2 Защитна стена

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-File','C:\wow\setup\06-firewall-lan.ps1'
Start-Process powershell -Verb RunAs -ArgumentList '-File','C:\wow\setup\07-firewall-public.ps1'
```

### 7.3 Рутер

Пренасочването сочи към **стария** LAN адрес. Влез в рутера и насочи портове
**3724** и **8085** към новия. Направи и DHCP резервация, за да не се сменя.

> ⚠️ Порт **3306** (MySQL) никога не се пренасочва.

---

## 8. Панел, HUD, облачен агент

```powershell
cd C:\wow\panel       ; npm install ; cd C:\wow
cd C:\wow\cloud\agent ; npm install ; cd C:\wow
.\panel\hud-launcher\build-hud.ps1
```

Облачната част (Supabase + Vercel) не иска нищо — тя не знае къде работи
сървърът. Само `cloud\agent\.env` трябва да е на място.

---

## 9. Пускане и проверка

```powershell
cd C:\wow
.\START-SERVER.ps1
```

| Проверка | Очаквано |
|---|---|
| `.\setup\05-verify-no-client.ps1` | всичко зелено |
| `server\logs\Auth.log` | `Added realm "..." at <новия адрес>` |
| акаунти / герои | **13 / 96** |
| `server\logs\Playerbots.log` | ботове влизат |
| админ панел | http://localhost:8080 |
| HUD в браузър | http://localhost:8080/hud |
| HUD като програма | `.\AzerothCore-HUD.exe` след `build-hud.ps1` |
| отвън | **от телефон на мобилни данни** |

> ⚠️ Тест отвътре в мрежата не доказва нищо — той минава по `localAddress` и
> точно така се крие най-честата грешка.

---

## 10. Ако нещо се обърка

| Симптом | Причина |
|---|---|
| `0xc0000135`, нула редове в лога | липсва VC++ Redistributable или `libmysql.dll` |
| Прекъсва с `-1073740768` | липсва `legacy.dll` (раздел 4.4) |
| `Failure to read line number 1` | `.conf` файл със записан BOM |
| Реалмът липсва в списъка | `address` не се разрешава, или грешна маска |
| Минава входа и увисва | `localAddress` сочи към старата машина |
| Ботовете са на 1 ниво | `apply-settings.ps1` не е пуснат |
| Ботовете влизат веднага в подземието | пач 001 не е приложен преди строенето |
| `LNK2001: boost::throw_exception` | загубено `/EHsc` (раздел 4.3) |
| Всяко построяване е пълно | липсват изключенията на Defender |
| Ботовете стоят без да мърдат | най-често защитният механизъм работи, не е повреда |

---

## 11. Полезно след това

```powershell
# резервно копие на акаунти и герои (~4 MB)
.\setup\backup-databases.ps1

# записва промени по конфигурацията, за да не се губят пак
.\setup\export-settings.ps1

# прилага поправките по света, дошли с git pull
.\setup\apply-sql-fixes.ps1
```

> Пусни `export-settings.ps1` след **всяка** промяна в конфигурацията и
> commit-ни `setup\server-settings.conf`. Точно затова тази миграция е една
> команда, а не ден работа.

### Как поправка стига от едната машина до другата

| Вид промяна | Къде се записва | Другата машина |
|---|---|---|
| Рейт, поведение на ботове | `.conf` → `export-settings.ps1` | `git pull` + `apply-settings.ps1` |
| Счупен райд, дънджън, NPC, плячка | `setup\sql-fixes\NNN-*.sql` | `git pull` + `apply-sql-fixes.ps1` |
| Логика в C++ | нов `.patch` в `setup\patches\` | `git pull` + `git apply` + ново построяване |
| Панел, HUD, скриптове | направо в git | `git pull` |
| Акаунти и герои | **не минават през git** | само пълен дъмп |

> ⚠️ Двете машини **не са клъстер**. Ако работят едновременно, това са два
> отделни свята с отделни бази — героите се разминават и не могат да се слеят.
> Щом новата мине проверката, старата спира да приема играчи.

---

## 12. Какво НЕ влиза в git — и защо

| | Причина |
|---|---|
| `CREDENTIALS.txt`, `*-password.txt` | пароли |
| `cloud\agent\.env` | ключ за Supabase с пълни права |
| живи `.conf` файлове | съдържат паролата за базата |
| `server\`, `build\`, `source\`, `mysql\` | гигабайти, възпроизводими |
| явните `.sql` дъмпове | SRP6 verifier-ите са еквивалент на паролите |

Репото е **публично**. Не слагай нищо от горните в него.

**Смени паролите след преместването**, ако файловете са пътували по несигурен
канал. По-евтино е сега.
