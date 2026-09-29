import { Col, Row, Carousel } from "react-bootstrap";
import FidgetWidget from "../components/games/FidgetWidget";
import ConwayCanvas from "../components/games/ConwayCanvas";
import { Link } from "react-router-dom";
import { ParallaxBanner } from "react-scroll-parallax";
import styled from "styled-components";

const CarouselImage = styled.img`
    height: 550px;
    object-fit: cover;
    width: 100%;
`;

const Home = () => {
    return (
        <>
            <ParallaxBanner
                layers={[
                    { image: 'img/IMG_7578.jpg', translateY: [-40, 0] },
                    {
                        startScroll: 80,
                        endScroll: 800,
                        translateY: [49, 70],
                        children: (
                            <Row className="p-2 mx-auto d-flex flex-row justify-content-center align-items-center" style={{backgroundColor: "white", boxShadow: "0 5px 40px rgba(0,0,0,0.2)", maxWidth: "800px"}}>
                                <Col sm={3} className="m-4 d-flex justify-content-center" style={{width: "120px", height: "100px"}}>
                                    <FidgetWidget height="100px" width="100px" />
                                </Col>
                                <Col className="text-md-start text-center p-0 m-0">
                                    <h2>Julian Sanker</h2>
                                    <h5>CS graduate of Yale. Interested in artificial intelligence, computational biology, and software engineering.</h5>
                                    <Link to="https://www.linkedin.com/in/juliansanker" target="_blank" rel="noreferrer" 
                                        className="fa fa-linkedin fa-1x p-1 text-decoration-none text-black"></Link>
                                    <Link to="https://github.com/jpsank" target="_blank" rel="noreferrer"
                                        className="fa fa-github fa-1x p-1 text-decoration-none text-black">
                                    </Link>
                                </Col>
                            </Row>
                        )
                    }
                ]}
                style={{height: "900px", maxWidth: "1000px"}}
                className="mx-auto"
            />
            <Col className="m-0 p-0 text-center" style={{backgroundColor: "white"}}>
                <ConwayCanvas nrows={300} ncols={500} width="1000px" height="600px" style={{maxWidth: "100%", boxShadow: "0 5px 40px rgba(0,0,0,0.2)"}} />
            </Col>
            <Row className="m-0 d-flex flex-row justify-content-center align-items-center">
                <ParallaxBanner
                    layers={[
                        { image: 'img/photos/IMG_8387.jpg', translateY: [-40, 10] },
                    ]}
                    style={{height: "500px", maxWidth: "1000px", boxShadow: "0 5px 40px #rgba(0,0,0,0.2)"}}
                    className="aspect-[2/1]"
                />
            </Row>
            <Row className="my-5 mx-auto d-flex flex-row justify-content-around align-items-center gap-4" style={{maxWidth: "800px"}}>
                <Col md={5} className="text-center">
                    <img style={{width: "100%", maxWidth: "400px"}} src="img/me690.png" alt="Julian Sanker" />
                </Col>
                <Col className="px-4">
                    <h1>About</h1>
                    <p>I'm a Yale University graduate with a degree in Computer Science, from Northwest Arkansas.</p>
                    <p>I enjoy creating software, particularly websites and useful apps. I'm looking for jobs in software engineering, artificial intelligence, and computational biology.</p>
                    <p>I also enjoy nature, and I'm interested in creating models of living organisms using <a href="https://nn.cs.utexas.edu/downloads/papers/stanley.ec02.pdf" target="_blank" rel="noreferrer">neural networks and evolutionary algorithms</a>.</p>
                    <p>Reach out to me at <a href="mailto:julian@sankergroup.org">julian@sankergroup.org</a> or <a href="https://calendly.com/juliansanker">schedule a meeting</a>.</p>
                </Col>
            </Row>
            <Row className="m-0 d-flex flex-row text-center justify-content-center align-items-center">
                <ParallaxBanner
                    layers={[
                        {
                            translateY: [21, 30],
                            children: (
                                <Carousel className="p-0">
                    <Carousel.Item>
                        <CarouselImage src="img/photos/lake.jpeg" alt="Lake Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Lake Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/cat.jpeg" alt="Johnson, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Johnson, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/blessings.jpeg" alt="Johnson, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Johnson, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/doorway.jpeg" alt="Johnson, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Johnson, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/car.jpeg" alt="Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/deer.jpeg" alt="Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/fence1.jpeg" alt="Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/log.jpeg" alt="Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Lake Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/fence2.jpeg" alt="Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/twilight.jpeg" alt="Fayetteville, Arkansas" />
                        <Carousel.Caption>
                            <h3 className="roboto">Fayetteville, Arkansas</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                    <Carousel.Item>
                        <CarouselImage src="img/photos/hha.jpeg" alt="Haas Hall Academy, Fayetteville, AR" style={{
                            objectPosition: "50% 80%"
                        }} />
                        <Carousel.Caption>
                            <h3 className="roboto">Haas Hall Academy, Fayetteville, AR</h3>
                        </Carousel.Caption>
                    </Carousel.Item>
                </Carousel>
                            )
                        }
                    ]}
                    style={{height: "600px", boxShadow: "0 5px 40px #rgba(0,0,0,0.2)"}}
                    className="aspect-[2/1]"
                />
            </Row>
        </>
    );
};

export default Home;
