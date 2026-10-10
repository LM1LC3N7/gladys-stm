# STM Montréal

Cette intégration affiche dans Gladys les **prochains passages d'autobus** de la
STM, l'**état des lignes de métro** et la **disponibilité des stations BIXI**.

Elle n'est ni affiliée à la Société de transport de Montréal (STM) ni à BIXI
Montréal. Les données viennent des données ouvertes de la STM (licence CC BY
4.0, source : Société de transport de Montréal) et du flux GBFS public de BIXI.

## Ce qu'il faut

- Gladys Assistant **5.1.0** ou plus récent.
- Pour les autobus et le métro : une **clé d'API STM**, gratuite et personnelle.
- Pour BIXI : rien, le flux est ouvert.

## Obtenir la clé d'API STM

1. Créez un compte sur le
   [portail développeurs de la STM](https://portail.developpeurs.stm.info/apihub).
2. Ajoutez une application.
3. Abonnez-la aux API **GTFS-realtime** (passages d'autobus) et **i3** (état du
   service).
4. Créez une clé, puis publiez-la.
5. Collez la clé dans le champ « Clé d'API STM » de la configuration de
   l'intégration. Le « secret partagé » n'est pas nécessaire.

Le bouton **Tester la clé d'API STM** vérifie les deux API séparément. Il
indique ainsi à quelle API votre application n'est pas abonnée.

### Quota

La STM accorde **10 000 requêtes par jour et par compte**, toutes applications
confondues. L'intégration lit le flux des autobus **une seule fois par
intervalle, quel que soit le nombre d'arrêts**. Avec les réglages par défaut,
elle consomme environ :

- 1 440 requêtes par jour pour les autobus (une lecture par minute) ;
- 720 requêtes par jour pour le métro (une lecture toutes les 2 minutes).

Le statut de connexion affiché dans Gladys indique l'estimation pour votre
configuration. Les widgets du tableau de bord réutilisent les dernières lectures
et ne consomment donc pas de quota supplémentaire.

## Que surveiller

### Arrêts d'autobus

Le **code d'arrêt** est le numéro à cinq chiffres inscrit sur chaque panneau
d'arrêt de la STM. On le trouve aussi dans l'application et sur stm.info.

Syntaxe du champ « Arrêts d'autobus » : `<code>[@<ligne>|<ligne>][:<nom>]`.
Séparez les arrêts par des virgules.

| Saisie                    | Signification                                    |
| ------------------------- | ------------------------------------------------ |
| `52743`                   | tous les autobus qui passent à l'arrêt 52743     |
| `51003@24`                | seulement la ligne 24                            |
| `61503@69\|469`           | les lignes 69 et 469                             |
| `51003@24:Bus du travail` | ligne 24, affiché sous le nom « Bus du travail » |

Un arrêt ne dessert qu'un seul sens de circulation : choisissez l'arrêt du côté
de la rue où vous prenez l'autobus.

Chaque arrêt devient un appareil avec :

- **Prochain passage**, **Passage 2**… : le nombre de minutes d'attente. La
  valeur 999 signifie qu'aucun passage n'est prévu.
- **Ligne du prochain passage**… : le numéro de ligne.
- **Prochains passages** : un résumé, par exemple
  `24 3 min · 24 11 min · 747 14 min`.

Le nombre de passages exposés se règle avec « Passages par arrêt » (1 à 5).

### Métro

L'option **Surveiller le métro** (activée par défaut) crée un appareil « Métro
STM ». Pour chacune des lignes verte, orange, jaune et bleue, il expose :

- **état** : `Normal`, `Perturbé`, `Avis` ou `Inconnu` ;
- **message** : le message de la STM, par exemple « Service normal du métro »
  ou le texte de l'interruption.

Le métro n'a pas de prédictions en temps réel dans les données ouvertes de la
STM. L'intégration ne donne donc que l'état des lignes, et non les horaires des
rames.

### Stations BIXI

Saisissez les identifiants de stations, avec un nom optionnel après `:`, par
exemple `1, 42:Station de la maison`. Le bouton **Chercher une station BIXI**
trouve un identifiant à partir du nom de la station.

Chaque station devient un appareil avec :

- **Vélos** : le nombre de vélos disponibles, vélos électriques compris ;
- **Vélos électriques** ;
- **Points d'ancrage libres** ;
- **État**.

## Tableau de bord

Trois widgets sont disponibles :

| Widget                 | Contenu                                                        |
| ---------------------- | -------------------------------------------------------------- |
| Passages d'autobus STM | le prochain passage et la liste des suivants                   |
| État du métro STM      | les 4 lignes en couleur, et le message des lignes non normales |
| Station BIXI           | vélos, vélos électriques, places, remplissage, courbe des 24 h |

## Scènes

**Déclencheurs :**

- **Autobus STM imminent** : un autobus passe sous un seuil de 1, 2, 3, 5, 10 ou
  15 minutes. Un filtre de ligne est disponible. Un même autobus est suivi
  d'une lecture à l'autre, donc l'autobus suivant qui prend sa place dans la
  liste ne déclenche pas la scène par erreur.
- **État du métro STM modifié** : une ligne est perturbée, revient à la
  normale, ou reçoit un avis.
- **Station BIXI modifiée** : la station n'a plus de vélos ou de places, en
  retrouve, ou change de service.

Rien ne se déclenche à la première lecture après un démarrage de l'intégration.

**Actions :**

- **Lire les prochains autobus STM** : renvoie la ligne, les minutes, le
  passage suivant et le résumé. Par exemple : « Ton 24 passe dans
  {{minutes}} minutes ».
- **Lire l'état d'une ligne de métro** : renvoie l'état, le message et
  `normal` (vrai ou faux).

## Dépannage

- **Rien dans l'écran Découverte** : vérifiez les champs « Arrêts d'autobus »
  et « Stations BIXI ». Le statut de connexion liste ce qui est surveillé.
- **« La STM a refusé la clé d'API »** : vérifiez la clé, puis vérifiez que
  l'application est abonnée aux deux API sur le portail.
- **« Quota épuisé »** : augmentez les intervalles de rafraîchissement, ou
  vérifiez qu'une autre application n'utilise pas le même compte.
- **Un arrêt reste à 999** : soit aucun autobus n'est prévu (la nuit), soit le
  code d'arrêt ou le filtre de ligne est erroné.

## Données et licences

- Données STM : licence
  [CC BY 4.0](https://www.stm.info/fr/a-propos/developpeurs/condition-dutilisation),
  source : Société de transport de Montréal.
- Données BIXI : flux GBFS public de BIXI Montréal.
- Code de l'intégration : licence Apache 2.0.
