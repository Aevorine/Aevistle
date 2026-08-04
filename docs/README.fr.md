<div align="center">

<img src="assets/logo.png" alt="Aevistle" width="104" height="104">

# Aevistle

**Des rappels par e-mail programmés qui arrivent vraiment.**

Rédigez un e-mail une fois — fichiers, images ou archives en pièce jointe — et
Aevistle l’envoie à l’heure dite, même fenêtre fermée. Une seule fois, chaque
jour ouvré à 09:00, le 1er du mois, ou selon n’importe quelle expression cron.
Il connaît vos jours fériés : le rapport du lundi ne part pas un lundi où
personne ne travaille.
Windows et Android, sans compte, sans serveur, sans télémétrie.

*Le rapport hebdomadaire du vendredi. La facture du 1er. Le message
d’anniversaire à minuit, pendant que vous dormez.*

[![Release](https://img.shields.io/github/v/release/Aevorine/Aevistle?style=flat-square&color=4f46e5)](https://github.com/Aevorine/Aevistle/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Aevorine/Aevistle/ci.yml?branch=main&style=flat-square&color=4f46e5&label=checks)](https://github.com/Aevorine/Aevistle/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-4f46e5?style=flat-square)](../LICENSE)
[![Windows](https://img.shields.io/badge/Windows-x64-4f46e5?style=flat-square&logo=windows)](https://github.com/Aevorine/Aevistle/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B-4f46e5?style=flat-square&logo=android)](https://github.com/Aevorine/Aevistle/releases/latest)

### [⬇ Télécharger](https://github.com/Aevorine/Aevistle/releases/latest) · [Ce qu’il fait](#ce-quil-fait) · [Confidentialité](#confidentialité) · [Sécurité](#sécurité)

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
| 📮 **Envoyer maintenant ou plus tard** | Les deux boutons qui comptent sont ancrés en bas de l’écran de rédaction, à toutes les tailles de fenêtre. Vous ne faites jamais défiler pour envoyer. L’heure d’envoi se trouve juste à côté, déjà remplie avec l’heure ronde suivante plutôt que laissée vide, et elle change de forme selon la règle : une date et une heure pour un envoi unique, une heure de la journée pour une règle quotidienne, hebdomadaire, mensuelle ou annuelle — c’est le champ sur lequel ces règles se déclenchent réellement — et aucun éditeur du tout pour une expression cron, parce que l’expression *est* la règle. |
| 📥 **Boîte de réception optionnelle** | Activez l’IMAP pour un compte : Aevistle renseigne le serveur, le teste avant l’enregistrement, puis regroupe tous les comptes dans une boîte unifiée — vue globale ou filtrée sur un compte, vérifiée selon l’intervalle que vous choisissez. Un message ouvert occupe toute la fenêtre ; `Échap` revient en arrière. `J`/`K` passent d’un message à l’autre, `Ctrl+F` cherche à l’intérieur. Les pièces jointes reçues s’affichent sur place — images, PDF, texte — ou s’ouvrent avec l’application du système, s’enregistrent où vous voulez, ou se montrent dans le gestionnaire de fichiers. Les images distantes restent bloquées et chaque lien passe par une confirmation qui affiche la vraie destination. |
| 🔑 **Les codes de vérification, sur leur propre écran** | Codes et liens de connexion sont extraits automatiquement du courrier entrant et rassemblés sur un écran dédié : expéditeur, objet, heure d’arrivée et le code lui-même, assez grand pour être lu d’un coup d’œil. Un clic n’importe où sur la carte le copie. Une notification transporte le code — plus besoin d’ouvrir quoi que ce soit — et l’historique survit à la suppression du message d’origine. |
| 📨 **Du courrier qui devient un rappel** | Réunions, rendez-vous et échéances sont repérés dans le courrier reçu, dans les six langues de l’application, et un bouton transforme l’un d’eux en rappel programmé. La carte affiche la phrase d’où la date a été tirée, pour que vous puissiez la vérifier au lieu de lui faire confiance, et dit franchement quand la formulation laissait la date ouverte à plusieurs lectures. Une vraie invitation transporte une partie `text/calendar` où la date est déjà énoncée exactement : elle est lue de préférence à la prose, sous Windows ; la boîte de réception Android ne conserve pas ces parties, elle retombe donc sur la lecture du texte. Ne rien dire est l’échec préférable : une date manquée coûte une relecture du message, une date fausse coûte une réunion. |
| ⚡ **Envoi en rafale** | Un seul déclenchement programmé peut envoyer le même message plusieurs fois de suite, cadencé selon le nombre de millisecondes que vous choisissez — pour tester la charge de votre propre circuit d’envoi, pas pour spammer qui que ce soit. |
| 📎 **Pièces jointes et images dans le corps** | Documents, images, archives — tout ce qui reste sous la limite de votre fournisseur. Collez une image copiée directement dans le message pour l’insérer en ligne ; toute image jointe peut aussi passer de pièce jointe à image affichée dans le message, et revenir. Aevistle affiche la taille réelle transmise : le base64 transforme un fichier de 20 Mo en 27 Mo, et c’est pour cela que des pièces jointes « sous la limite » sont rejetées. |
| 🖼️ **Des images que l’on voit vraiment** | Chaque image d’un message — insérée dans le corps, jointe en pièce, ou arrivée dans votre boîte — s’affiche en vignette lisible plutôt qu’en nom de fichier à deviner. Un clic ouvre la visionneuse plein écran : molette pour zoomer, glisser pour déplacer, double-clic pour basculer entre taille ajustée et taille réelle, rotation d’un quart de tour dans les deux sens, miroir horizontal ou vertical, flèches pour parcourir les autres images du message, et lecture des dimensions en pixels, de la taille et du format avant d’enregistrer ou de copier dans le presse-papiers. `Échap` ferme l’image, et rien d’autre. |
| 📆 **La grille du mois, c’est le planning** | Chaque case de jour liste ce qui part vraiment ce jour-là — heure, destinataire, objet. Un clic ouvre le rappel correspondant, un glisser sur un autre jour le déplace, un double-clic sur un jour vide en crée un nouveau à cette date. Un glisser annonce ce qu’il va faire avant de le faire : un envoi unique se déplace, une règle récurrente *change*, parce qu’il n’existe aucune liste d’exceptions par occurrence où écrire « saute ce mardi-ci, envoie le jeudi à la place », et un glisser qui réécrirait en silence une règle hebdomadaire serait pire qu’un glisser qui refuse. Les cases sont teintées selon la charge du jour, sur une échelle fixe — 1, 2, 3, 5, 8 envois — pour que le même mardi ait la même teinte le mois prochain. Une échelle normalisée sur le jour le plus chargé à l’écran repeindrait tout le mois à chaque rappel ajouté : c’est de la décoration, pas de l’information. |
| ⚠️ **Les envois qui se télescopent, et un bouton pour ça** | Les rappels qui tombent dans la même minute sont signalés sur le jour où ils tombent. Un clic les étale dans une fenêtre de ±5 minutes, puis nomme ceux qu’il a laissés où ils étaient, et pourquoi — une expression cron est maîtresse de sa propre minute, et un décalage qui franchirait minuit est un changement de *jour*, ce que quelques minutes n’ont pas le droit de vouloir dire. Il modifie l’heure de la règle, donc tous les envois à venir suivent ; il le dit dans la confirmation, et `Ctrl+Z` remet tout le lot en place d’un seul coup. |
| 🎌 **Les jours ouvrés que vous définissez** | Jours fériés, week-ends de votre choix et jours de rattrapage, sur une grille mensuelle où un clic bascule un jour. Des points de départ en un clic pour six pays, les tables légales chinoises transcrites, jours de rattrapage 调休 compris, et l’`.ics` à l’entrée comme à la sortie. Chaque rappel décide pour lui-même s’il suit le calendrier, et la grille marque les envois que le calendrier a *déplacés* — la seule chose qui réponde à « est-ce que tout ce paramétrage a servi à quelque chose ». La recherche « vérifier en ligne » des dates légales d’une année n’avait jamais fonctionné dans aucune version : la politique de sécurité de contenu de l’application refusait la requête émise depuis l’interface, et l’échec ressemblait exactement à une panne de réseau. Elle part désormais par le processus de confiance, la politique restant aussi stricte qu’avant. |
| 🌐 **La journée de travail du destinataire** | Un contact peut porter un fuseau horaire et des heures de travail, et un rappel qui lui est adressé tombe dans *sa* journée plutôt que dans la vôtre — « chaque lundi à 09:00 » écrit depuis Shanghai arrive sinon à 03:00 à Los Angeles, la seule heure de la semaine où personne ne lit son courrier. Cela s’applique après le calendrier de travail et après les heures calmes, et l’emporte sur les deux : un message relâché dans le matin du destinataire peut donc très bien tomber en pleine nuit chez vous — c’est la fonction qui marche, pas qui échoue. Seule la ligne `To:` est consultée : mettre quelqu’un en copie, ce n’est pas chercher à le joindre, et une copie carbone n’a pas à retarder le courrier du vrai destinataire. **Rien n’est jamais retenu ni abandonné** : un jeu de fenêtres qui ne peuvent pas toutes être satisfaites, ou simplement mal configuré, est signalé, et le message part à l’heure que vous avez fixée. L’éditeur énonce la conséquence sous forme de phrase — à quelle heure partirait réellement un rappel réglé sur telle heure, et quelle heure il sera là où le destinataire se trouve — parce que chaque valeur de ce formulaire est plausible et qu’aucune ne peut être vérifiée en la relisant. |
| 🗒️ **Un résumé de votre propre planning** | Optionnel : un courrier par jour, à vous-même, listant ce qui part aujourd’hui, ce qui est dû dans les sept jours à venir, et ce qui se télescope. Ce n’est pas une tâche de fond cachée quelque part — c’est un rappel ordinaire dans votre planning, visible sur le même écran, suspendable et supprimable comme n’importe quel autre, la seule version de cette fonction que cette application accepte d’avoir. Quand un nombre est un plancher plutôt qu’un total, il le dit, et le corps du message porte l’instant où il a été calculé, car la machine a très bien pu l’envoyer des heures plus tard. |
| 🎉 **Des vœux de fête, planifiés plutôt qu’envoyés** | Choisissez un pays et une année : Aevistle calcule où tombent les jours fériés légaux et vous montre la liste. Rien n’existe tant que vous n’avez pas appuyé sur le bouton, et ce qu’il crée alors, ce sont des tâches programmées ordinaires et visibles. Des jours consécutifs portant le même nom forment une seule occasion — la fête nationale qui court du 1er au 7 octobre, c’est un vœu, pas sept messages identiques en une semaine. Pour une année chinoise que le Conseil des affaires d’État n’a pas encore annoncée, il retombe sur les dates fixes et indique la source retenue, plutôt que d’extrapoler le calendrier lunaire de l’an dernier et de se tromper délibérément. |
| ⌨️ **Le clavier, et un panneau qui dit vrai** | Chaque onglet porte un numéro, chaque raccourci est listé, et la liste est engendrée à partir des onglets eux-mêmes — elle ne peut donc plus se désynchroniser comme elle venait de le faire. |
| 📤 **Emportez vos rappels avec vous** | Exportez vos planifications dans un fichier et importez-les sur une autre installation. Aucun compte, aucun serveur, aucun mot de passe n’entre jamais dans ce fichier : on peut le garder dans une sauvegarde sans crainte. |
| 📅 **Exporter les heures auxquelles il enverra vraiment** | L’export `.ics` de vos rappels peut écrire la règle de récurrence, ou les instants que cette application a déjà arrêtés — décalages de jours fériés et heures calmes appliqués. Les deux divergent volontairement : « chaque jour ouvré à 09:00 » est une règle vraie et un planning faux dès lors que le calendrier a déplacé l’envoi du 1er octobre au 8, et un abonné qui lit la règle regarderait un plan qu’Aevistle a décidé de ne pas suivre. **La limite, dite franchement :** Outlook, Thunderbird et Apple Calendar savent s’abonner au fichier enregistré. Google Calendar non — il ne lit que des adresses web publiques, et cette application n’a aucun serveur où en poser une. Une liste déroulée se périme aussi dès qu’elle dépasse les heures déjà calculées : c’est pour cela que c’est un mode et non le comportement par défaut. |
| ✒️ **Mettre en forme sans éditeur de texte enrichi** | Gras, italique, code, liens, listes et citations, insérés en Markdown dans la même zone de texte brut. C’est rendu en HTML compatible avec les messageries au moment du départ, de sorte que le destinataire reçoit une mise en forme et non des astérisques. |
| 🔤 **Variables de fusion, y compris celles du calendrier** | `{{name}}`, `{{email}}` et vos propres champs de contact, remplis pour chaque destinataire, avec Cc et Cci retirés des copies — une fusion, ce sont quarante lettres privées, pas un seul fil avec quarante personnes dessus. À côté d’elles, `{{nextWorkday}}`, `{{prevWorkday}}`, `{{holiday}}`, `{{nextHoliday}}`, `{{nextDayOff}}`, `{{daysToNextHoliday}}`, `{{workdaysLeftThisWeek}}` et `{{workdaysLeftThisMonth}}` lisent le même calendrier de travail qui décide *quand* le message part, et sont résolues au moment de l’envoi — ainsi un rappel que le calendrier a repoussé au lundi ne dit plus « à demain ». Il n’y a délibérément pas de `{{isWorkday}}` : il faudrait le rendre sous forme de mot, dans une langue que cette partie de l’application ne connaît pas. Une variable qu’il ne peut pas remplir est laissée en place plutôt que vidée en silence. |
| 🔍 **Chercher là où vous le voulez** | Restreignez la recherche de la boîte de réception à l’expéditeur, à l’objet ou au texte d’aperçu — parce que chercher une personne fait remonter chaque lettre d’information qui mentionne son nom. |
| 👆 **Balayage sur un téléphone** | Balayez un message pour le retirer, ou pour basculer son état lu / non lu. Volontairement pas la suppression côté serveur : celle-là est irréversible et n’a rien à faire derrière un geste. |
| 📊 **On voit que c’est parti** | Chaque ligne indique le dernier envoi, s’il a réussi, et combien de fois elle s’est déclenchée. Les rappels uniques passent dans un onglet Terminés une fois faits, au lieu de rester dans la liste à prétendre attendre. |
| 🗑️ **Une suppression qui veut dire quelque chose** | Deux actions distinctes, parce que ce sont deux demandes distinctes : retirer d’Aevistle (réversible depuis une corbeille conservée sept jours) ou supprimer de la boîte mail sur le serveur (irréversible, et c’est dit). |
| ✍️ **Mode concentration** | `F9` masque tout sauf le message et lui donne toute la fenêtre. `Échap` ramène le reste. Un compteur de caractères et d’octets vit sur l’étiquette — un idéogramme fait trois octets, et c’est l’octet que compte la limite de votre fournisseur. |
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
| ⬆️ **Mises à jour intégrées** | Interroge les Releases GitHub, télécharge l’installateur, le vérifie face au SHA-256 publié et le transmet au système. Sous Android, l’APK est confié à l’installateur du système. Désactivable ; rien d’autre que la requête n’est envoyé. Sur Android, cette vérification n’avait jamais fonctionné dans aucune version publiée — la même politique de sécurité de contenu qui empêche un corps de message d’ouvrir une socket refusait aussi la requête de mise à jour, et l’échec se présentait sous une erreur impossible à distinguer d’une absence de connexion. La requête part désormais par le processus de confiance, sur une liste blanche fixée à l’hôte *et* au chemin, plutôt que d’avoir élargi la politique. |
| 🌍 **Six langues** | English, 简体中文, Français, Español, Русский, العربية — avec une vraie mise en page de droite à gauche pour l’arabe. |
| 🎨 **Six styles visuels, pas six teintes** | Aurora, Graphite, Paper, Midnight, Nordic et Contraste élevé, choisis sur des vignettes d’aperçu dans **Réglages → Apparence**. Un style n’est pas un simple changement de couleur : chacun réajuste aussi le rayon des angles, la hauteur de ligne et la quantité d’ombre autorisée, ce qui fait que Graphite se lit comme un autre logiciel plutôt que comme le même en gris. Chaque style est livré avec une vraie déclinaison claire et une vraie déclinaison sombre, pour que « suivre le système » continue de fonctionner quel que soit votre choix. **Contraste élevé** est celui où un chiffre fait le design : chaque paire de texte dépasse 7:1, WCAG AAA, y compris les horodatages tertiaires et les couleurs sémantiques sur leurs propres fonds teintés — là où les jeux AAA s’arrêtent d’ordinaire sans le dire. Ses bordures sont visibles à dessein, à 3,9:1 en clair et 6,3:1 en sombre, au-delà des 3:1 demandés pour la limite d’un contrôle. Par-dessus les styles : clair et sombre suivant le système ou fixés, sept couleurs d’accent — réaccordées par chaque style plutôt que retirées, pour que le choix survive au passage en Contraste élevé — deux densités, et un choix de police par écriture : Songti (宋体) pour le chinois, Times New Roman pour le latin et la ponctuation. |

## Téléchargement

La dernière version se trouve dans **[Releases](https://github.com/Aevorine/Aevistle/releases/latest)**.

| Plateforme | Fichier | Remarques |
|---|---|---|
| Windows 10/11 (x64) | `Aevistle-<version>-win-x64-setup.exe` | Programme d’installation, avec raccourcis menu Démarrer et bureau |
| Windows 10/11 (x64) | `Aevistle-<version>-win-x64-portable.exe` | Fichier unique, sans installation, fonctionne depuis une clé USB |
| Android 7.0+ | `Aevistle-<version>.apk` | Téléphones et tablettes. Autorisez d’abord « installer des applications inconnues » pour votre navigateur ou gestionnaire de fichiers. |

`<version>` est le numéro affiché sur la page de la
[dernière version](https://github.com/Aevorine/Aevistle/releases/latest) — le
badge en haut de cette page le lit au même endroit. Volontairement pas écrit en
dur ici, pour que ce tableau ne puisse pas se périmer.

> **Vérifier un téléchargement.** Chaque version publie `SHA256SUMS.txt`, une
> signature détachée `SHA256SUMS.txt.asc` et la clé publique correspondante :
>
> ```bash
> gpg --import aevistle-public-key.asc
> gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
> sha256sum -c SHA256SUMS.txt
> ```
>
> Les sommes de contrôle prouvent que le fichier est arrivé intact ; la
> signature prouve qu'il vient de la clé de ce projet. L'empreinte se trouve
> dans [SECURITY.md](../SECURITY.md).

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

<div align="center">
<img src="assets/screenshot-settings.png" alt="Les réglages d’Aevistle : le compte mail et le dossier de données" width="880">
</div>

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
   jour** et l’application ne fait plus jamais celle-là de son côté.
5. **Une table de jours fériés, seulement quand vous appuyez sur « vérifier en
   ligne »** — une requête `GET` non authentifiée pour les dates d’une seule
   année. Celle-ci comme la vérification de mise à jour sont sur liste blanche
   par hôte *et* par chemin exact, et toutes deux partent du processus de
   confiance, non de la partie de l’application qui affiche le courrier,
   laquelle n’a aucun accès réseau sortant.

Mises à jour désactivées, chaque requête qui reste dans cette liste est une
requête pour laquelle vous avez appuyé sur un bouton.

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

21 contrôles, sortie en langage clair, code de sortie 1 si quelque chose cloche.

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

- [ ] OAuth 2.0 pour Gmail et Microsoft 365, pour ne plus avoir besoin de mots
      de passe d’application
- [ ] Un éditeur de texte enrichi. Les images intégrées fonctionnent déjà ; la
      zone de saisie, elle, reste du texte brut avec du Markdown
- [ ] Versions bureau macOS et Linux (le code les vise déjà)
- [ ] iOS

Il manque quelque chose ? [Ouvrez un ticket](https://github.com/Aevorine/Aevistle/issues) —
les demandes de fonctionnalités sont les bienvenues.

## Contribuer

Les pull requests sont bienvenues. Voir **[CONTRIBUTING.md](../CONTRIBUTING.md)**
et **[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)**.
Ajouter une septième langue tient dans un fichier et ne demande aucun outillage :
le système de types indique exactement quelles chaînes manquent.

Les rapports de bogue et les demandes de fonctionnalité ont des
[modèles](https://github.com/Aevorine/Aevistle/issues/new/choose) ; chaque pull
request passe le même `npm run check` que vous lanceriez en local.

## Licence

[MIT](../LICENSE) © Aevistle contributors
