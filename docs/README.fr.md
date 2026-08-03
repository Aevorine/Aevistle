<div align="center">

<img src="assets/logo.png" alt="Aevistle" width="104" height="104">

# Aevistle

**Des rappels par e-mail programmés qui arrivent vraiment.**

Rédigez un e-mail une fois — avec des fichiers, des images ou des archives en
pièce jointe — et Aevistle l’envoie à l’heure dite. Une seule fois, chaque jour
ouvré à 09:00, le 1er du mois, ou selon n’importe quelle expression cron.
La même application sur Windows et sur Android.

[![Release](https://img.shields.io/github/v/release/Aevorine/Aevistle?style=flat-square&color=4f46e5)](https://github.com/Aevorine/Aevistle/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-4f46e5?style=flat-square)](../LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64-4f46e5?style=flat-square&logo=windows)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B-4f46e5?style=flat-square&logo=android)](https://github.com/Aevorine/Aevistle/releases/latest)

[English](../README.md) ·
[简体中文](README.zh-CN.md) ·
**Français** ·
[Español](README.es.md) ·
[Русский](README.ru.md) ·
[العربية](README.ar.md)

</div>

---

<div align="center">
<img src="assets/screenshot-compose.png" alt="La fenêtre de rédaction d’Aevistle" width="880">
</div>

---

## Pourquoi ce logiciel existe

N’importe quel client de messagerie sait envoyer un e-mail. Presque aucun ne
sait vous promettre qu’il partira mardi prochain à 07:00 avec la bonne pièce
jointe — que vous y pensiez ou non, que l’application soit ouverte ou non.

Aevistle tient d’abord cette promesse-là. Aucun compte à créer — il se connecte
au serveur SMTP que vous avez déjà (Gmail, Outlook, QQ, 163, le serveur de
votre entreprise) et envoie. La réception existe aussi, mais elle reste en
retrait tant que vous ne l’activez pas : pointez un compte vers son serveur
IMAP, et Aevistle rapatrie une boîte de réception unifiée, extrait
automatiquement les codes de vérification et les liens de connexion, et laisse
tout le reste tranquille par défaut.

**On s’en sert pour** envoyer un rapport hebdomadaire chaque vendredi à 17 h · rappeler un devoir à une classe la veille · expédier une facture le 1er de chaque mois · poster un message d’anniversaire à minuit en dormant · relancer un loyer tous les 30 jours · programmer une relance qui arrive le matin plutôt qu’à 2 h · récupérer un code de connexion dès son arrivée sans changer d’application.

**Ce n’est sans doute pas pour vous si** vous cherchez un client de messagerie complet — pas de gestion de dossiers, pas de synchronisation push IDLE, pas de suppression côté serveur, volontairement — un outil marketing avec pixels de suivi et taux d’ouverture, ou un service hébergé qui continue d’envoyer appareils éteints. Aevistle envoie et lit depuis *votre* machine avec *votre* boîte — c’est précisément pourquoi il n’a besoin d’aucun compte qui lui soit propre et ne collecte rien.

## Ce qu’il fait

| | |
|---|---|
| 📮 **Envoyer maintenant ou plus tard** | Les deux boutons qui comptent sont ancrés en bas de l’écran de rédaction, à toutes les tailles de fenêtre. Vous ne faites jamais défiler pour envoyer. |
| 📥 **Boîte de réception optionnelle** | Activez l’IMAP pour un compte : Aevistle renseigne le serveur, le teste avant l’enregistrement, puis regroupe tous les comptes dans une boîte unifiée — vue globale ou filtrée sur un compte, vérifiée selon l’intervalle que vous choisissez. Un message ouvert occupe toute la fenêtre ; `Échap` revient en arrière. `J`/`K` passent d’un message à l’autre, `Ctrl+F` cherche à l’intérieur. Les pièces jointes reçues s’affichent sur place — images, PDF, texte — ou s’ouvrent avec l’application du système, s’enregistrent où vous voulez, ou se montrent dans le gestionnaire de fichiers. Les images distantes restent bloquées et chaque lien passe par une confirmation qui affiche la vraie destination. |
| 🔑 **Les codes de vérification, sur leur propre écran** | Codes et liens de connexion sont extraits automatiquement du courrier entrant et rassemblés sur un écran dédié : expéditeur, objet, heure d’arrivée et le code lui-même, assez grand pour être lu d’un coup d’œil. Un clic n’importe où sur la carte le copie. Une notification transporte le code — plus besoin d’ouvrir quoi que ce soit — et l’historique survit à la suppression du message d’origine. |
| ⚡ **Envoi en rafale** | Un seul déclenchement programmé peut envoyer le même message plusieurs fois de suite, cadencé selon le nombre de millisecondes que vous choisissez — pour tester la charge de votre propre circuit d’envoi, pas pour spammer qui que ce soit. |
| 📎 **Pièces jointes et images dans le corps** | Documents, images, archives — tout ce qui reste sous la limite de votre fournisseur. Collez une image copiée directement dans le message pour l’insérer en ligne ; toute image jointe peut aussi passer de pièce jointe à image affichée dans le message, et revenir. Aevistle affiche la taille réelle transmise : le base64 transforme un fichier de 20 Mo en 27 Mo, et c’est pour cela que des pièces jointes « sous la limite » sont rejetées. |
| 🔁 **Une vraie récurrence** | Une fois · toutes les N minutes · quotidienne · hebdomadaire selon les jours choisis · mensuelle (avec une règle sensée pour le 31) · annuelle · cron complet à 5 champs. |
| 🔒 **Instantanés des pièces jointes** | Programmez un rappel pour le mois prochain : Aevistle garde sa propre copie des fichiers, donc déplacer ou renommer les originaux ne casse rien en silence. |
| ⏰ **Se déclenche fenêtre fermée** | Windows conserve un processus dans la zone de notification ; Android utilise une alarme exacte et WorkManager. Fermer la fenêtre n’annule pas vos rappels. |
| 🌙 **Politique de rattrapage** | Portable en veille pendant trois échéances ? Choisissez un seul envoi de rattrapage, ou aucun. Vous ne vous réveillerez pas avec trois e-mails identiques. |
| 🎲 **Décalage aléatoire et week-ends** | Répartissez les envois dans une fenêtre pour que votre fournisseur ne prenne pas une rafale pour du spam, et reportez au lundi ce qui tombe le week-end. |
| 🔐 **Les mots de passe restent chez vous** | Chiffrés par le système — DPAPI sous Windows, Keystore matériel sous Android. Jamais dans le fichier de réglages, jamais dans un export. |
| 📂 **Votre dossier, vos règles** | Aevistle demande où ranger vos données au premier démarrage, et **Réglages → Dossier de données** permet d’en changer ensuite. Il déplace l’existant **et corrige les chemins enregistrés dans les planifications**, pour qu’un rappel créé le mois dernier retrouve sa pièce jointe. |
| 🔌 **Des connexions qui aboutissent** | Port et chiffrement mal appariés ? Aevistle essaie l’autre combinaison acceptée par votre fournisseur au lieu d’échouer sur « Unexpected socket close », puis propose d’enregistrer ce qui a marché. Chaque tentative est bornée : le bouton de test répond toujours. |
| 🩺 **Il dit ce qui s’est passé** | Un test réussi indique le point de connexion retenu et le temps d’aller-retour ; un échec nomme la cause et ce qu’il faut changer. L’écran d’activité tient un taux de réussite et un temps médian. |
| 🌙 **Heures calmes** | Les rappels nocturnes attendent le matin. Un envoi manuel n’est jamais retenu — vous êtes devant l’écran. |
| ⬆️ **Mises à jour intégrées** | Interroge les Releases GitHub, télécharge l’installateur, le vérifie face au SHA-256 publié et le transmet au système. Sous Android, l’APK est confié à l’installateur du système. Désactivable ; rien d’autre que la requête n’est envoyé. |
| 🌍 **Six langues** | English, 简体中文, Français, Español, Русский, العربية — avec une vraie mise en page de droite à gauche pour l’arabe. |
| 🎨 **Agréable à regarder** | Clair et sombre, suivant le système ou fixé, six couleurs d’accent, deux densités, et un choix de police par écriture : Songti (宋体) pour le chinois, Times New Roman pour le latin et la ponctuation. |

## Téléchargement

La dernière version se trouve dans **[Releases](https://github.com/Aevorine/Aevistle/releases/latest)**.

| Plateforme | Fichier | Remarques |
|---|---|---|
| Windows 10/11 (x64) | `Aevistle-0.1.0-win-x64-setup.exe` | Programme d’installation, avec raccourcis menu Démarrer et bureau |
| Windows 10/11 (x64) | `Aevistle-0.1.0-win-x64-portable.exe` | Fichier unique, sans installation, fonctionne depuis une clé USB |
| Android 7.0+ | `Aevistle-0.1.0.apk` | Téléphones et tablettes. Autorisez d’abord « installer des applications inconnues » pour votre navigateur ou gestionnaire de fichiers. |

> Windows SmartScreen signalera un éditeur inconnu. C’est l’aspect normal d’une
> version sans certificat de signature payant : choisissez **Informations
> complémentaires → Exécuter quand même**, ou vérifiez d’abord l’empreinte
> SHA-256 depuis la page de la version.

## Premiers pas

1. **Ajoutez votre boîte mail.** Réglages → Ajouter un compte. Choisissez votre
   fournisseur : serveur, port et chiffrement sont remplis pour vous.
2. **Créez un mot de passe d’application.** Gmail, Outlook, Yahoo, iCloud, QQ et
   163 refusent tous votre mot de passe habituel depuis une application tierce.
   La boîte de dialogue renvoie directement vers la page de création.
3. **Testez la connexion.** Un bouton. Il s’authentifie sans rien envoyer : vous
   le savez maintenant plutôt qu’à 03:00.
4. **Écrivez votre rappel**, joignez ce qu’il faut, puis choisissez **Planifier**.

Pour que les envois programmés partent fenêtre fermée, laissez
*Garder actif dans la zone de notification* activé (Windows) et autorisez les
alarmes exactes et les notifications quand Android le demande.

## Confidentialité

Aevistle n’a aucun serveur. Aucun compte à créer, aucune télémétrie, aucun
rapport de plantage.

Une liste courte et fixe de choses qui quittent votre appareil, et rien d’autre :

1. **La connexion SMTP vers votre propre fournisseur de messagerie** — votre
   message, vers la boîte que vous avez configurée.
2. **La connexion IMAP vers votre propre fournisseur de messagerie** —
   uniquement pour les comptes où vous avez activé la réception, uniquement
   pour récupérer le courrier de ce compte.
3. **Une image distante dans un message reçu, seulement quand vous demandez
   explicitement à la charger** — chaque image est bloquée par défaut et
   remplacée par un espace réservé, car une balise `<img>` distante est le plus
   vieux traceur du courrier électronique. La récupération elle-même est
   protégée contre une redirection vers votre propre réseau (aucune IP
   interne, aucune redirection suivie).
4. **Une vérification de mise à jour**, si vous la laissez active : une requête
   `GET` non authentifiée vers `api.github.com` demandant quelle est la
   dernière version. Elle ne transporte ni identifiants de compte, ni contenu
   de message, ni données d’usage. Désactivez-la dans **Réglages → Mises à
   jour** et l’application ne fait plus aucune requête de son côté.

Tout reste sur votre appareil :

| | Windows | Android |
|---|---|---|
| Réglages, planifications, contacts, journal | `<dossier de données>\state.json` | stockage de l’application |
| Mots de passe | `secrets.json`, chiffré avec DPAPI | Android Keystore (matériel si disponible) |
| Mots de passe IMAP | Même fichier, même chiffrement, une entrée Keystore distincte du mot de passe SMTP de ce compte | Même Keystore, entrée distincte |
| Copies des pièces jointes | `<dossier de données>\attachments\` | `<dossier de données>/attachments` |
| Cache du courrier reçu (corps, pièces jointes) | `<dossier de données>\inbox\` — un cache borné, avec un âge et une taille limite réglables dans **Réglages**, sans risque à supprimer : il se resynchronise | `<dossier de données>/inbox` |

Le dossier de données démarre dans `%APPDATA%\Aevistle` sous Windows et dans le
stockage privé sous Android ; **Réglages → Dossier de données** le déplace où
vous pouvez écrire. Sous Android, le choix se fait entre les volumes que le
système autorise réellement une application à écrire (privé, partagé, carte SD),
car un dossier choisi via le sélecteur de documents ne peut pas être ouvert par
l’envoi en arrière-plan plusieurs heures plus tard.

Deux choses ne suivent volontairement pas : les mots de passe, chiffrés pour
votre compte système et inutilisables ailleurs, et — sous Android — le
calendrier des alarmes, pour qu’une carte retirée n’empêche pas un rappel.

Un export de réglages ne contient jamais de mot de passe.

## Sécurité

Le modèle de menace, les choix de durcissement et la procédure de signalement
sont dans **[SECURITY.md](../SECURITY.md)**.

En bref : le rendu s’exécute sans accès Node, avec isolation de contexte et une
CSP stricte ; toute chaîne destinée à un en-tête de courrier est rejetée si elle
contient un saut de ligne (c’est ainsi que naissent les relais ouverts) ; les
certificats TLS sont vérifiés sauf désactivation explicite par compte ; le HTML
d’un message reçu est assaini dans le processus principal selon une liste
stricte avant même d’atteindre le rendu, puis affiché dans un iframe en bac à
sable sans aucune exécution de script possible ; et le récepteur d’alarme
Android n’est pas exporté, donc aucune autre application ne peut faire envoyer
un courrier par Aevistle.

Vous pouvez tout vérifier vous-même :

```bash
npm run audit:self
```

20 contrôles, sortie en langage clair, code de sortie 1 si quelque chose cloche.

## Compiler depuis les sources

**Prérequis** — Node.js 20+, et pour Android : JDK 17+, Android SDK
(plateforme 36, build-tools 35+). `npm run build:android` détecte un JDK et un
SDK installés mais absents du `PATH`, donc `JAVA_HOME` est facultatif.

```bash
git clone https://github.com/Aevorine/Aevistle.git
cd Aevistle
npm install
```

| Tâche | Commande |
|---|---|
| Lancer dans un navigateur (sans SMTP, tout le reste réel) | `npm run dev` |
| Vérification de types | `npm run typecheck` |
| Audit de sécurité | `npm run audit:self` |
| Lancer l’application de bureau | `npm start` |
| Construire les installeurs Windows | `npm run dist:win` |
| Construire l’APK Android | `npm run build:android` |

La signature de publication Android lit `~/.aevistle/keystore.properties` ou les
variables `AEVISTLE_KEYSTORE*`. Sans l’un ni l’autre, la compilation retombe sur
la clé de débogage : l’APK reste installable.

## Architecture

Une interface React + TypeScript, deux enveloppes natives.

```
src/core/        indépendant de la plateforme : modèle, moteur de récurrence,
                 validation, préréglages SMTP — ni DOM, ni Node, ni Android
src/             l’interface React (six langues, deux thèmes)
    ↓ PlatformBridge — l’unique jointure entre l’UI et un système
electron/        Windows : nodemailer + imapflow, secrets DPAPI, zone de
                 notification, assainissement HTML pour le courrier reçu
android/         Android : JavaMail (envoi + réception), Keystore, AlarmManager + WorkManager
```

Le moteur de récurrence vit délibérément en TypeScript seulement. Il précalcule
une liste d’horodatages absolus, et le planificateur de chaque plateforme se
contente de répondre « réveille-moi à T » — toutes les règles de calendrier
(années bissextiles, mois courts, heure d’été, week-ends) existent donc une
seule fois, dans un seul langage, et se testent sans émulateur.

Plus de détails dans **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Feuille de route

Pas des promesses — ce qui viendra le plus probablement ensuite.

- [ ] OAuth 2.0 pour Gmail et Microsoft 365
- [ ] Éditeur enrichi avec images intégrées
- [ ] Import/export des planifications
- [ ] Versions macOS et Linux (le code les vise déjà)
- [ ] Variables de modèle par destinataire (`{{name}}`)
- [ ] iOS

Il manque quelque chose ? [Ouvrez un ticket](https://github.com/Aevorine/Aevistle/issues) —
les demandes de fonctionnalités sont les bienvenues.

## Contribuer

Les pull requests sont bienvenues. Voir **[CONTRIBUTING.md](../CONTRIBUTING.md)**.
Ajouter une septième langue tient dans un fichier et ne demande aucun outillage :
le système de types indique exactement quelles chaînes manquent.

## Licence

[MIT](../LICENSE) © Aevistle contributors
