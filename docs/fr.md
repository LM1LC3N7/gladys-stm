# STM Montréal

Les **prochains autobus** de la STM, l'**état du métro** et les **vélos BIXI**
près de chez vous, dans Gladys.

Cette intégration n'est affiliée ni à la Société de transport de Montréal (STM)
ni à BIXI Montréal.

## Démarrer en 3 étapes

Aucune connaissance technique n'est nécessaire, et aucun compte non plus pour
commencer.

1. **Vérifiez l'adresse de votre maison dans Gladys** : _Paramètres →
   Maisons_. La maison doit avoir une position sur la carte. L'intégration s'en
   sert pour trouver les arrêts proches de chez vous. La position reste dans
   votre Gladys.
2. **Installez l'intégration** depuis le catalogue des intégrations, et
   acceptez l'accès à la position de la maison. Ouvrez sa page de
   configuration et cliquez sur **Enregistrer**, sans rien remplir.
3. Ouvrez l'onglet **Découverte** de l'intégration. Les 3 arrêts d'autobus et
   les 2 stations BIXI les plus proches de chez vous y sont proposés, avec
   leur nom et la direction des lignes, par exemple « Bus – Notre-Dame / Peel (36 →
   Ouest) ». Cliquez sur **Ajouter** pour chacun de ceux qui vous intéressent.

C'est tout. Vous avez maintenant, pour chaque arrêt, les **horaires prévus**
des prochains autobus, et pour chaque station BIXI, les vélos et les places
libres.

Le message en haut de la page de configuration indique toujours la prochaine
chose à faire. Par exemple : « Prêt : 3 arrêts et 2 stations BIXI à ajouter.
Ouvrez l'onglet Découverte… ».

Les noms des appareils commencent par **Bus –** ou **BIXI –**, pour les
reconnaître d'un coup d'œil dans la liste des appareils de Gladys. Vous pouvez
les renommer librement dans Gladys.

### Afficher les passages sur le tableau de bord

1. Ouvrez le tableau de bord, puis cliquez sur **Modifier**.
2. Ajoutez un widget et choisissez **Passages d'autobus STM**.
3. Choisissez l'arrêt, puis enregistrez.

Le widget **Station BIXI** s'ajoute de la même façon. Le widget **État du
métro STM** demande une clé STM (voir plus bas).

Les horaires prévus sont marqués d'un **~**, comme sur les panneaux de la STM :
« ~12 min » signifie « prévu dans 12 minutes ».

## Passer au temps réel et ajouter le métro (facultatif)

Avec une **clé d'API STM**, gratuite et personnelle :

- les horaires prévus deviennent des **prédictions en temps réel** (la position
  réelle des autobus) ;
- l'appareil **Métro STM** apparaît, avec l'état des lignes verte, orange,
  jaune et bleue.

### Obtenir la clé d'API STM (5 minutes)

1. Allez sur le
   [portail développeurs de la STM](https://portail.developpeurs.stm.info/apihub)
   et **créez un compte** (adresse courriel et mot de passe). Confirmez le
   courriel que vous recevez.
2. Une fois connecté, **ajoutez une application**. Le nom n'a pas d'importance,
   par exemple « Gladys maison ».
3. Dans cette application, **abonnez-vous aux deux API** :
   - **GTFS-realtime** : les passages des autobus en temps réel ;
   - **i3** : l'état du service du métro.
4. **Créez une clé**, puis **publiez-la**. Le portail affiche une « clé d'API »
   et un « secret partagé ». Seule la clé d'API est nécessaire.
5. Dans Gladys, ouvrez la configuration de l'intégration. Collez la clé dans
   **Clé d'API STM**, puis cliquez sur **Enregistrer**.
6. Cliquez sur **Tester la clé d'API STM**. Les deux lignes doivent afficher ✔.
   Une ligne ✖ indique quelle API manque dans votre application.
7. Retournez dans l'onglet **Découverte** et ajoutez l'appareil **Métro STM**.

Les libellés du portail STM peuvent varier légèrement : en cas de doute, la
[FAQ du portail](https://www.stm.info/fr/a-propos/developpeurs) décrit les
mêmes étapes.

**Quota.** La STM accorde 10 000 requêtes par jour et par compte. Avec les
réglages par défaut, l'intégration en utilise environ 2 200, **quel que soit
le nombre d'arrêts** : une seule lecture des données de la STM sert tous vos
arrêts. Le message de la page de configuration affiche l'estimation pour
votre installation.

## Surveiller d'autres arrêts (travail, école…)

Pour un arrêt loin de chez vous :

1. En bas de la page de configuration, cliquez sur **Chercher un arrêt**.
   Tapez une intersection, par exemple « Sherbrooke Papineau ».
2. La réponse liste les arrêts avec leur code et la direction de leurs lignes,
   par exemple `52682 — Papineau / Sherbrooke (24 → Est, 45 → Sud)`.
3. Copiez le code (`52682`) dans **Arrêts d'autobus**, enregistrez, puis
   ajoutez l'arrêt dans l'onglet **Découverte**.

Le code est aussi le numéro à cinq chiffres inscrit sur chaque panneau d'arrêt
de la STM.

Pour les stations BIXI, le bouton **Chercher une station BIXI** fonctionne de
la même façon.

### Pour aller plus loin

Le champ **Arrêts d'autobus** accepte plusieurs codes séparés par des
virgules, un filtre de lignes après `@` et un nom après `:`.

| Saisie                    | Signification                                    |
| ------------------------- | ------------------------------------------------ |
| `52743`                   | tous les autobus qui passent à l'arrêt 52743     |
| `51003@24`                | seulement la ligne 24                            |
| `61503@69\|469`           | les lignes 69 et 469                             |
| `51003@24:Bus du travail` | ligne 24, affiché sous le nom « Bus du travail » |

## Ce que contient chaque appareil

**Arrêt d'autobus :**

- **Prochain passage**, **Passage 2**… : les minutes d'attente. 999 signifie
  qu'aucun passage n'est prévu.
- **Ligne du prochain passage**… : le numéro de ligne.
- **Prochains passages** : un résumé, par exemple `24 3 min · 747 14 min`.

**Métro STM** (avec une clé) : pour chaque ligne, un **état** (`Normal`,
`Perturbé`, `Avis` ou `Inconnu`) et le **message** de la STM. La STM ne
publie pas d'horaires des rames en temps réel : seul l'état des lignes est
disponible.

**Station BIXI :** les vélos (électriques compris), les vélos électriques, les
points d'ancrage libres et l'état de la station.

## Scènes

**Déclencheurs :**

- **Autobus STM imminent** : un autobus passe sous 1, 2, 3, 5, 10 ou 15
  minutes. Exemple : « quand le 24 est à 5 minutes, allumer la lampe de
  l'entrée ».
- **État du métro STM modifié** : une ligne est perturbée, revient à la
  normale, ou reçoit un avis. Exemple : « si la ligne orange est perturbée,
  m'envoyer un message ».
- **Station BIXI modifiée** : la station n'a plus de vélos ou de places, ou
  en retrouve.

**Actions :**

- **Lire les prochains autobus STM** : par exemple, un message chaque matin
  « Ton 24 passe dans {{minutes}} minutes ».
- **État d'une ligne de métro** : renvoie l'état, le message de la STM et
  `normal` (vrai ou faux).

## Dépannage

| Message ou symptôme                                    | Que faire                                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| « indiquez l'adresse de votre maison »                 | _Paramètres → Maisons_ : placez la maison sur la carte, puis enregistrez à nouveau la configuration de l'intégration. |
| « Gladys n'a pas partagé la position de votre maison » | Réinstallez l'intégration et acceptez l'accès à la position, ou tapez des codes d'arrêt.                              |
| Rien dans l'onglet Découverte                          | Lisez le message de la page de configuration : il dit ce qui manque.                                                  |
| « La STM a refusé la clé d'API »                       | Vérifiez la clé, et que l'application est abonnée aux deux API (GTFS-realtime et i3).                                 |
| « Quota épuisé »                                       | Augmentez les intervalles (section Avancé), ou vérifiez qu'une autre application n'utilise pas le même compte STM.    |
| Un arrêt reste à 999                                   | Aucun autobus prévu (la nuit), ou un filtre de ligne qui ne correspond à aucune ligne de l'arrêt.                     |

## Vie privée, données et licences

- La position de la maison ne sert qu'à chercher les arrêts proches. Seul un
  rectangle de quelques centaines de mètres autour de la maison est envoyé à
  Transitous. Rien n'est envoyé ailleurs.
- Horaires prévus, noms d'arrêts et recherche :
  [Transitous](https://transitous.org/sources/), un service communautaire
  gratuit, à partir des données de la STM.
- Temps réel et état du métro : données ouvertes de la STM, licence
  [CC BY 4.0](https://www.stm.info/fr/a-propos/developpeurs/condition-dutilisation),
  source : Société de transport de Montréal.
- Vélos : flux GBFS public de BIXI Montréal.
- Code de l'intégration : licence Apache 2.0.
